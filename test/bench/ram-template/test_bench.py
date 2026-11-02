"""Host-only checks: no KVM, libvirt, network privileges or guest execution required."""
import io
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock

from bench import VM, rpc, snapshot_config


class ConfigTests(unittest.TestCase):
    def test_clone_changes_only_private_paths_and_disk_format(self):
        original = {'disks': [{'id': '_disk0', 'path': '/template.raw', 'image_type': 'Raw'}],
                    'vsock': {'cid': 3, 'socket': '/source/vsock.sock'},
                    'serial': {'mode': 'File', 'file': '/source/serial.log'},
                    'memory': {'size': 2048, 'shared': False}}
        saved = json.dumps(original)
        clone = snapshot_config(original, Path('/private/clone'))
        self.assertEqual(json.dumps(original), saved, 'never mutate the source configuration')
        self.assertEqual(clone['disks'][0]['path'], '/private/clone/disk.qcow2')
        self.assertEqual(clone['disks'][0]['image_type'], 'Qcow2')
        self.assertTrue(clone['disks'][0]['backing_files'])
        self.assertEqual(clone['disks'][0]['id'], '_disk0')
        self.assertEqual(clone['vsock']['socket'], '/private/clone/vsock.sock')
        self.assertEqual(clone['vsock']['cid'], 3, 'hybrid vsock is scoped to the private Unix socket')
        self.assertEqual(clone['memory'], original['memory'])

    def test_rejects_multiple_disks(self):
        with self.assertRaisesRegex(ValueError, 'exactly one disk'):
            snapshot_config({'disks': [{}, {}]}, Path('/private/clone'))


class RpcTests(unittest.TestCase):
    def exchange(self, response, handshake=b'OK 1234\n'):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'vsock.sock'
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(path))
            server.listen(1)
            seen = []
            errors = []

            def serve():
                try:
                    conn, _ = server.accept()
                    with conn:
                        stream = conn.makefile('rb')
                        seen.append(stream.readline())
                        conn.sendall(handshake)
                        if handshake.startswith(b'OK '):
                            seen.append(json.loads(stream.readline()))
                            conn.sendall(response)
                except Exception as e:
                    errors.append(e)

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            try:
                return rpc(path, {'action': 'hello'}, timeout=1)
            finally:
                thread.join(timeout=2)
                server.close()
                self.assertFalse(thread.is_alive())
                self.assertFalse(errors)
                self.assertEqual(seen[0], b'CONNECT 19090\n')

    def test_success(self):
        self.assertEqual(self.exchange(b'{"ok":true,"result":{"assigned":false}}\n'), {'assigned': False})

    def test_agent_failure_propagates(self):
        with self.assertRaisesRegex(RuntimeError, 'incorrect instance secret'):
            self.exchange(b'{"ok":false,"error":"incorrect instance secret"}\n')

    def test_invalid_handshake(self):
        with self.assertRaisesRegex(RuntimeError, 'handshake failed'):
            self.exchange(b'', handshake=b'ERR unavailable\n')

    def test_truncated_reply(self):
        with self.assertRaisesRegex(RuntimeError, 'missing/oversized'):
            self.exchange(b'{"ok":true}')


class CleanupTests(unittest.TestCase):
    def test_stops_process_and_escalates_only_after_timeout(self):
        vm = object.__new__(VM)
        vm.process = Mock()
        vm.process.poll.return_value = None
        vm.process.wait.side_effect = [subprocess.TimeoutExpired('vmm', 5), 0]
        vm.log = io.StringIO()
        vm.stop()
        vm.process.terminate.assert_called_once()
        vm.process.kill.assert_called_once()
        self.assertEqual(vm.process.wait.call_count, 2)
        self.assertTrue(vm.log.closed)


if __name__ == '__main__':
    unittest.main()
