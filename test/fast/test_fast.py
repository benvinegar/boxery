"""No KVM/network privileges required: validate the experimental fast path's boundaries."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


runtime = module('fast_runtime', 'host/fast/runtime.py')
guest = module('fast_guest', 'host/fast/guest.py')


def identity(fresh=True):
    return {'version': 1, 'action': 'assign', 'fresh': fresh, 'name': 'test-vm', 'kind': 'desktop',
            'incarnation': 'a' * 32, 'entropy': 'b' * 128, 'time': 1790000000,
            'keys': ['ssh-ed25519 AAAAfixture host'], 'upstream': 'VSOCK-CONNECT:2:8088',
            'files': [[name, '{}'] for name in sorted(guest.ALLOWED)],
            'network': {'mac': '52:54:00:77:00:01', 'address': '10.77.1.2', 'gateway': '10.77.1.1', 'dns': '1.1.1.1', 'prefix': 24}}


class GuestValidation(unittest.TestCase):
    def test_agent_cannot_accidentally_listen_on_the_host(self):
        with patch.object(guest.os, 'geteuid', return_value=1000), patch.object(guest.socket, 'socket') as listener:
            with self.assertRaisesRegex(RuntimeError, 'prepared Boxery guest'):
                guest.main()
            listener.assert_not_called()

    def test_complete_fresh_assignment(self):
        guest.validate(identity())

    def test_resume_does_not_replay_old_credentials(self):
        request = identity(False)
        for field in ['files', 'keys', 'kind', 'upstream']:
            del request[field]
        guest.validate(request)

    def test_rejects_entire_bad_request_before_any_effects(self):
        for field, value in [('version', 2), ('fresh', 'true'), ('name', '../../escape'),
                             ('incarnation', 'old'), ('entropy', '00'), ('time', float('nan')),
                             ('kind', 'unknown'), ('keys', ['ssh-ed25519 AAAA\ninjected']),
                             ('upstream', 'TCP:host:8088'), ('files', [['../../root', 'secret']])]:
            with self.subTest(field=field):
                request = identity()
                request[field] = value
                with patch.object(guest, 'run') as effect:
                    with self.assertRaises((ValueError, TypeError, KeyError)):
                        guest.assign(request)
                    effect.assert_not_called()

    def test_rejects_wrong_network(self):
        for field, value in [('mac', '52:54:00:77::001'), ('address', 'not-an-IP'), ('prefix', 16)]:
            request = identity()
            request['network'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                guest.validate(request)

    def test_atomic_home_write_cannot_follow_directory_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / 'home'
            outside = Path(d) / 'outside'
            home.mkdir()
            outside.mkdir()
            (home / '.pi').symlink_to(outside, target_is_directory=True)
            with patch.object(guest, 'HOME', home), self.assertRaisesRegex(ValueError, 'escapes'):
                guest.atomic(home / '.pi/token', 'secret')
            self.assertFalse((outside / 'token').exists())

    def test_atomic_write_replaces_file_symlink_without_following_it(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            outside = home / 'untouched'
            outside.write_text('keep')
            (home / 'token').symlink_to(outside)
            with patch.object(guest, 'HOME', home):
                guest.atomic(home / 'token', 'new')
            self.assertEqual(outside.read_text(), 'keep')
            self.assertEqual((home / 'token').read_text(), 'new')
            self.assertEqual((home / 'token').stat().st_mode & 0o777, 0o600)


class Catalog(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'index').mkdir()
        self.version = self.root / 'versions' / ('a' * 32)
        self.version.mkdir(parents=True)
        self.index = self.root / 'index/desktop-2-2048-20-passt.json'
        self.index.write_text(json.dumps({'id': 'a' * 32}))
        files = {}
        for name in ['disk.raw', 'memory-ranges', 'config.json', 'state.json', 'firmware']:
            (self.version / name).write_bytes(b'test')
            files[name] = {'size': 4, 'sha256': 'not-rehashed-on-each-create'}
        config = json.dumps({'cpus': {'boot_vcpus': 2}, 'memory': {'size': 2048 * 1024 * 1024, 'shared': True}, 'disks': [{}]})
        (self.version / 'config.json').write_text(config)
        files['config.json']['size'] = len(config)
        self.manifest = {'version': 2, 'cpu': 'cpu', 'agent': 'agent', 'arch': 'x86_64', 'hypervisor': 'cloud-hypervisor v54.0',
                         'kind': 'desktop', 'cpus': 2, 'mem': 2048, 'disk': 20, 'network': 'passt', 'files': files}
        self.save()
        for target, value in [('cpu_id', 'cpu'), ('agent_id', 'agent'), ('run', 'cloud-hypervisor v54.0')]:
            p = patch.object(runtime, target, return_value=value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(runtime.shutil, 'which', return_value='/bin/vmm')
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(runtime.platform, 'machine', return_value='x86_64')
        p.start()
        self.addCleanup(p.stop)

    def save(self):
        (self.version / 'manifest.json').write_text(json.dumps(self.manifest))

    def lookup(self):
        return runtime.catalog(self.root, 'desktop', 2, 2048, 20, 'passt')

    def test_exact_match(self):
        self.assertEqual(self.lookup(), self.version)

    def test_no_shape_match_is_explicit_cold_fallback(self):
        self.assertIsNone(runtime.catalog(self.root, 'desktop', 8, 2048, 20, 'passt'))
        self.assertIsNone(runtime.catalog(self.root, 'headless', 2, 2048, 20, 'passt'))

    def test_corrupt_selected_entry_is_not_a_cold_fallback(self):
        self.index.write_text('{')
        with self.assertRaises(ValueError):
            self.lookup()

    def test_no_path_traversal(self):
        self.index.write_text(json.dumps({'id': '../../escape'}))
        with self.assertRaisesRegex(ValueError, 'catalog entry'):
            self.lookup()

    def test_host_abi_and_version_must_match(self):
        for field, value in [('version', 99), ('cpu', 'different'), ('agent', 'old-code'), ('arch', 'aarch64'),
                             ('hypervisor', 'cloud-hypervisor v55.0'), ('mem', 4096)]:
            saved = self.manifest[field]
            self.manifest[field] = value
            self.save()
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.lookup()
            self.manifest[field] = saved

    def test_missing_truncated_and_symlink_assets_fail_closed(self):
        file = self.version / 'memory-ranges'
        file.write_bytes(b'')
        with self.assertRaisesRegex(ValueError, 'truncated'):
            self.lookup()
        file.unlink()
        file.symlink_to(self.version / 'disk.raw')
        with self.assertRaisesRegex(ValueError, 'linked'):
            self.lookup()
        file.unlink()
        with self.assertRaises(FileNotFoundError):
            self.lookup()

    def test_hardware_mismatch_fails(self):
        config = json.loads((self.version / 'config.json').read_text())
        config['cpus']['boot_vcpus'] = 8
        raw = json.dumps(config)
        (self.version / 'config.json').write_text(raw)
        self.manifest['files']['config.json']['size'] = len(raw)
        self.save()
        with self.assertRaisesRegex(ValueError, 'hardware'):
            self.lookup()

    def test_incomplete_asset_manifest_fails(self):
        del self.manifest['files']['memory-ranges']
        self.save()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.lookup()


class Configuration(unittest.TestCase):
    def test_restore_and_disk_only_images_have_distinct_boot_paths(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            profile = root / 'template'
            profile.mkdir()
            for name in ['firmware', 'memory-ranges', 'state.json']:
                (profile / name).write_text('fixture')
            (profile / 'manifest.json').write_text(json.dumps({'kind': 'desktop'}))
            (profile / 'config.json').write_text(json.dumps({'disks': [{}], 'payload': {}, 'vsock': {}, 'serial': {}}))
            seed = root / 'seed'
            Path(str(seed) + '.json').write_text(json.dumps({'version': 1, 'name': 'test', 'kind': 'desktop'}))
            meta = root / 'image.fast.json'
            meta.write_text(json.dumps({'template': str(profile)}))
            with patch.dict(os.environ, {'BOXERY_CH_NET_MODE': 'tap', 'BOXERY_CH_TAP_PREFIX': 'bx12345678'}), patch.object(runtime.shutil, 'which', side_effect=lambda n: '/bin/' + n), patch.object(runtime, 'run'):
                for restore in [True, False]:
                    directory = root / ('restore' if restore else 'cold')
                    directory.mkdir()
                    runtime.configure(directory, 'test', 2, 2048, 20, 1, seed,
                                      template=profile if restore else None, image_meta=None if restore else meta)
                    config = json.loads((directory / 'runtime.json').read_text())
                    self.assertEqual(config['restore'], restore)
                    self.assertTrue(config['agent'])
                    self.assertEqual(config['firmware'], str(profile / 'firmware'))
                    self.assertIn('tap=bx123456781', runtime.net_args(config, directory))
                    self.assertEqual((directory / 'restore').exists(), restore)
                    if restore:
                        saved = json.loads((directory / 'restore/config.json').read_text())
                        self.assertEqual(saved['payload'], {'firmware': str(profile / 'firmware')})
                        self.assertEqual(saved['disks'][0]['path'], str(directory / 'disk.qcow2'))
                        self.assertEqual(saved['vsock']['socket'], str(directory / 'vsock.sock'))
                        self.assertEqual((directory / 'restore/memory-ranges').stat().st_ino, (profile / 'memory-ranges').stat().st_ino)


class Protocol(unittest.TestCase):
    def test_private_vsock_handshake_and_error(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'sock'
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(listener.close)
            listener.bind(str(path))
            listener.listen(1)
            seen = []

            def serve():
                conn, _ = listener.accept()
                with conn:
                    stream = conn.makefile('rb')
                    seen.append(stream.readline())
                    conn.sendall(b'OK 123\n')
                    seen.append(json.loads(stream.readline()))
                    conn.sendall(b'{"ok":false,"error":"assignment rejected"}\n')

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            with self.assertRaisesRegex(RuntimeError, 'assignment rejected'):
                runtime.rpc(path, {'action': 'hello'})
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(seen, [b'CONNECT 19091\n', {'action': 'hello'}])


if __name__ == '__main__':
    unittest.main()
