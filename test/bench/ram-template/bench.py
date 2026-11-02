#!/usr/bin/env python3
"""Benchmark a TRUSTED, locally prepared Cloud Hypervisor RAM template.

This bypasses Boxery lifecycle/leases intentionally. No network, real grants,
proxy credentials, or production APIs are involved. See README.md for setup and
limitations. Requires Python 3, qemu-img, and Cloud Hypervisor/ch-remote v54+.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import statistics
import subprocess
import time

PREFIX = b'CONNECT 19090\n'


def rpc(sock_path, request, timeout=20):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(sock_path))
        stream = sock.makefile('rb')
        sock.sendall(PREFIX)
        reply = stream.readline(256)
        if not reply.startswith(b'OK '):
            raise RuntimeError(f'vsock handshake failed: {reply!r}')
        sock.sendall(json.dumps(request).encode() + b'\n')
        line = stream.readline(4 * 1024 * 1024)
        if not line.endswith(b'\n'):
            raise RuntimeError('missing/oversized agent response')
        reply = json.loads(line)
        if not reply['ok']:
            raise RuntimeError(reply['error'])
        return reply['result']


def memory_stats(pid):
    result = {}
    for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in ['Rss', 'Pss', 'Private_Dirty', 'Shared_Clean', 'Shared_Dirty', 'AnonHugePages']:
            result[key + '_kib'] = int(value.split()[0])
    mappings = Path(f'/proc/{pid}/maps').read_text().splitlines()
    result['template_file_mapped'] = any('memory-ranges' in line and 'rw-p' in line for line in mappings)
    return result


def run(argv):
    return subprocess.run([str(a) for a in argv], check=True, capture_output=True, text=True).stdout


def snapshot_config(original, directory):
    config = json.loads(json.dumps(original))
    if len(config['disks']) != 1:
        raise ValueError('experiment requires exactly one disk')
    config['disks'][0].update(path=str(directory / 'disk.qcow2'), image_type='Qcow2', backing_files=True)
    config['vsock']['socket'] = str(directory / 'vsock.sock')
    config['serial'].update(file=str(directory / 'serial.log'), mode='File')
    return config


class VM:
    def __init__(self, work, name, mode, binary):
        self.name, self.mode = name, mode
        self.directory = work / name
        self.secret = secrets.token_hex(32)
        self.process = None
        self.start = time.perf_counter()
        self.directory.mkdir(mode=0o700)
        original = json.loads((work / 'snapshot/config.json').read_text())
        root = Path(original['disks'][0]['path'])
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'raw', '-b', root, self.directory / 'disk.qcow2'])
        self.sock = self.directory / 'vsock.sock'
        if mode == 'cold':
            argv = [binary, '--api-socket', self.directory / 'api.sock', '--cpus', f"boot={original['cpus']['boot_vcpus']}",
                    '--memory', f"size={original['memory']['size']}", '--kernel', original['payload']['kernel'],
                    '--initramfs', original['payload']['initramfs'], '--cmdline', original['payload']['cmdline'],
                    '--disk', f'path={self.directory}/disk.qcow2,image_type=qcow2,backing_files=on',
                    '--vsock', f'cid=3,socket={self.sock}', '--serial', f'file={self.directory}/serial.log', '--console', 'off']
        else:
            snapshot = self.directory / 'snapshot'
            snapshot.mkdir()
            # RAM is shared via the same immutable inode, never copied for each clone.
            os.link(work / 'snapshot/memory-ranges', snapshot / 'memory-ranges')
            shutil.copyfile(work / 'snapshot/state.json', snapshot / 'state.json')
            config = snapshot_config(original, self.directory)
            if mode == 'copyonwrite-no-thp':
                config['memory']['thp'] = False
            (snapshot / 'config.json').write_text(json.dumps(config))
            restore_mode = 'copyonwrite' if mode == 'copyonwrite-no-thp' else mode
            argv = [binary, '--api-socket', self.directory / 'api.sock', '--restore',
                    f'source_url={snapshot.as_uri()},memory_restore_mode={restore_mode},resume=true']
        self.setup_ms = self.elapsed()
        self.log = open(self.directory / 'vmm.log', 'w')
        self.process = subprocess.Popen([str(a) for a in argv], stdout=self.log, stderr=self.log)

    def elapsed(self):
        return round((time.perf_counter() - self.start) * 1000, 2)

    def request(self, action, **kwargs):
        return rpc(self.sock, dict(action=action, secret=self.secret, **kwargs))

    def wait(self, request):
        deadline = time.monotonic() + 40
        last = None
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f'{self.name} VMM exited {self.process.returncode}: ' + (self.directory / 'vmm.log').read_text()[-5000:])
            try:
                return request()
            except (OSError, ValueError, RuntimeError) as e:
                last = e
                time.sleep(0.01)
        raise TimeoutError(f'{self.name}: {last}')

    def ready(self, screenshot=True):
        hello = self.wait(lambda: rpc(self.sock, {'action': 'hello'}, timeout=1))
        if hello['assigned']:
            raise AssertionError('template unexpectedly carries an assigned credential')
        agent_ms = self.elapsed()
        # A clone must not execute commands until assigned.
        try:
            rpc(self.sock, {'action': 'probe', 'secret': 'wrong'}, timeout=1)
        except RuntimeError as e:
            assert 'unassigned' in str(e)
        else:
            raise AssertionError('unassigned clone accepted commands')
        assigned = rpc(self.sock, {'action': 'assign', 'instance': self.name,
                                   'secret': self.secret, 'entropy': secrets.token_hex(64)})
        assert assigned['instance'] == self.name
        assign_ms = self.elapsed()
        probe = self.wait(lambda: self.request('probe'))
        ready_ms = self.elapsed()
        assert probe['shell'] == 'shell-ok' and probe['novnc'] == 200 and probe['browser']
        assert probe['marker'] is None, 'clone inherited another clone\'s writable state'
        frame_ms = None
        if screenshot:
            frame = self.request('screenshot')
            png = base64.b64decode(frame['png'], validate=True)
            assert png.startswith(b'\x89PNG\r\n\x1a\n')
            (self.directory / 'desktop.png').write_bytes(png)
            frame_ms = self.elapsed()
        return dict(name=self.name, mode=self.mode, setup_ms=self.setup_ms,
                    agent_ms=agent_ms, assign_ms=assign_ms, ready_ms=ready_ms,
                    frame_ms=frame_ms, probe=probe, memory=memory_stats(self.process.pid))

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if hasattr(self, 'log'):
            self.log.close()


def emit(record):
    print(json.dumps(record), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--rounds', type=int, default=5)
    parser.add_argument('--modes', nargs='+', choices=['cold', 'copy', 'copyonwrite', 'copyonwrite-no-thp', 'ondemand'], default=['cold', 'copyonwrite'])
    parser.add_argument('--no-screenshot', action='store_true')
    parser.add_argument('--burst', type=int, default=0, help='also start this many COW clones concurrently (max 32)')
    parser.add_argument('--evict-template-cache', action='store_true',
                        help='fsync + POSIX_FADV_DONTNEED on these private template files before each trial; use a disk-backed work directory, not tmpfs')
    args = parser.parse_args()
    if not 1 <= args.rounds <= 100:
        parser.error('--rounds must be 1–100')
    if not 0 <= args.burst <= 32:
        parser.error('--burst must be 0–32')
    work = args.work_dir.resolve()
    binary = work / 'bin/cloud-hypervisor'
    memory = work / 'snapshot/memory-ranges'
    with open(memory, 'rb') as source:
        before = hashlib.file_digest(source, 'sha256').hexdigest()
    records = []
    root = Path(json.loads((work / 'snapshot/config.json').read_text())['disks'][0]['path'])
    # Alternate modes to reduce ordering bias; all source files are already local/cached.
    for round_ in range(args.rounds):
        for mode in args.modes:
            if args.evict_template_cache:
                for file in [memory, root]:
                    with open(file, 'rb') as source:
                        os.fsync(source.fileno())
                        os.posix_fadvise(source.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
            name = f'{mode}-{secrets.token_hex(4)}'
            vm = VM(work, name, mode, binary)
            try:
                record = vm.ready(screenshot=not args.no_screenshot)
                record['round'] = round_ + 1
                emit(record)
                records.append(record)
            finally:
                vm.stop()
    for mode in args.modes:
        rows = [r for r in records if r['mode'] == mode]
        summary = {'kind': 'summary', 'mode': mode, 'rounds': len(rows)}
        for field in ['setup_ms', 'agent_ms', 'assign_ms', 'ready_ms', 'frame_ms']:
            values = [r[field] for r in rows if r[field] is not None]
            if values:
                summary[field] = {'min': min(values), 'median': statistics.median(values), 'max': max(values)}
        emit(summary)
    if args.burst:
        burst = []
        start = time.perf_counter()
        try:
            for _ in range(args.burst):
                burst.append(VM(work, 'burst-' + secrets.token_hex(4), 'copyonwrite', binary))
            with ThreadPoolExecutor(max_workers=args.burst) as pool:
                rows = list(pool.map(lambda v: v.ready(screenshot=False), burst))
            emit({'kind': 'burst', 'count': len(burst),
                  'all_ready_ms': round((time.perf_counter() - start) * 1000, 2),
                  'per_clone_ready_ms': [r['ready_ms'] for r in rows],
                  'sum_pss_mib': round(sum(memory_stats(v.process.pid)['Pss_kib'] for v in burst) / 1024, 2)})
        finally:
            for v in burst:
                v.stop()
    # Keep two live restored clones to test COW separation and credential fencing.
    clones = []
    try:
        for _ in range(2):
            clones.append(VM(work, 'isolation-' + secrets.token_hex(4), 'copyonwrite', binary))
        a, b = clones
        ra, rb = [v.ready(screenshot=False) for v in clones]
        a.request('write-marker', value='only-in-a')
        assert a.request('probe')['marker'] == 'only-in-a'
        assert b.request('probe')['marker'] is None
        assert ra['probe']['machine_id'] != rb['probe']['machine_id']
        assert ra['probe']['random'] != rb['probe']['random']
        try:
            rpc(a.sock, {'action': 'probe', 'secret': b.secret})
        except RuntimeError as e:
            assert 'incorrect' in str(e)
        else:
            raise AssertionError('clone A accepted clone B credential')
        duplicate_boot_id = ra['probe']['boot_id'] == rb['probe']['boot_id']
        emit({'kind': 'isolation', 'disk_private': True, 'credentials_private': True,
              'machine_id_file_unique': True, 'random_samples_unique': True,
              'boot_id_duplicated': duplicate_boot_id,
              'memory_a': memory_stats(a.process.pid), 'memory_b': memory_stats(b.process.pid)})
    finally:
        for v in clones:
            v.stop()
    with open(memory, 'rb') as source:
        after = hashlib.file_digest(source, 'sha256').hexdigest()
    assert before == after, 'immutable RAM template changed'
    emit({'kind': 'template-integrity', 'sha256': after, 'unchanged': True})


if __name__ == '__main__':
    main()
