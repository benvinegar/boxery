#!/usr/bin/env python3
"""CH runtime/restore adapter. Runs INSIDE each VM's systemd service cgroup.

No daemon is detached by a lifecycle worker. Stopping the unit kills CH and its
optional passt child. Template selection occurs before side effects; failure to
match falls back to cold boot, but corrupt selected templates fail closed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import socket
import subprocess
import sys
import time

VERSION = 1
TEMPLATE_VERSION = 2
PORT = 19091


def atomic(file, value):
    temp = file.with_name(file.name + '.new')
    with open(temp, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
        json.dump(value, f)
    os.replace(temp, file)


def run(argv):
    return subprocess.run([str(a) for a in argv], check=True, capture_output=True, text=True).stdout.strip()


def cpu_id():
    fields = [l for l in Path('/proc/cpuinfo').read_text().split('\n\n')[0].splitlines()
              if l.split(':')[0].strip() in ('vendor_id', 'cpu family', 'model', 'stepping', 'flags')]
    return hashlib.sha256('\n'.join(fields).encode()).hexdigest()


def agent_id():
    return barrier_id(Path(__file__).with_name('guest.py').read_bytes(), Path(__file__).with_name('prepare-guest.sh').read_bytes())


def barrier_id(agent, setup):
    return hashlib.sha256(b'boxery-fast-v1\0' + agent + b'\0' + setup).hexdigest()


def catalog(root, kind, cpus, mem, disk, network):
    index = root / 'index' / f'{kind}-{cpus}-{mem}-{disk}-{network}.json'
    if not index.is_file():
        return None
    entry = json.loads(index.read_text())
    version = entry.get('id', '')
    if len(version) != 32 or any(c not in '0123456789abcdef' for c in version):
        raise ValueError('invalid template catalog entry')
    template = root / 'versions' / version
    if template.is_symlink():
        raise ValueError('template version must not be a symlink')
    manifest = json.loads((template / 'manifest.json').read_text())
    if manifest.get('agent') != agent_id():
        raise ValueError('template guest-agent changed; rebuild the clean template')
    if manifest.get('version') != TEMPLATE_VERSION or manifest.get('cpu') != cpu_id() or manifest.get('arch') != platform.machine():
        raise ValueError('template host/ABI mismatch; rebuild it on this host')
    if [manifest.get(k) for k in ['kind', 'cpus', 'mem', 'disk', 'network']] != [kind, cpus, mem, disk, network]:
        raise ValueError('template catalog/shape mismatch')
    binary = shutil.which('cloud-hypervisor')
    if not binary or run([binary, '--version']) != manifest['hypervisor']:
        raise ValueError('template hypervisor version mismatch')
    if set(manifest.get('files', {})) != {'disk.raw', 'memory-ranges', 'state.json', 'config.json', 'firmware'}:
        raise ValueError('incomplete template manifest')
    for name, metadata in manifest['files'].items():
        if name not in ('disk.raw', 'memory-ranges', 'state.json', 'config.json', 'firmware'):
            raise ValueError('invalid template asset')
        file = template / name
        if file.is_symlink() or file.stat().st_size != metadata['size']:
            raise ValueError('template asset missing, linked or truncated')
    saved = json.loads((template / 'config.json').read_text())
    if saved['cpus']['boot_vcpus'] != cpus or saved['memory']['size'] != mem * 1024 * 1024 or len(saved['disks']) != 1:
        raise ValueError('template hardware configuration does not match its manifest')
    if bool(saved['memory'].get('shared')) != (network == 'passt'):
        raise ValueError('template RAM sharing mode does not match its network')
    return template


def configure(directory, name, cpus, mem, disk, slot, seed, template=None, image_meta=None):
    mode = os.environ.get('BOXERY_CH_NET_MODE', 'tap')
    if mode not in ('tap', 'passt'):
        raise ValueError('BOXERY_CH_NET_MODE must be tap or passt')
    base = os.environ.get('BOXERY_CH_NET', '10.77')
    network = {'mode': mode, 'slot': slot, 'tap': os.environ.get('BOXERY_CH_TAP_PREFIX', 'bxch') + str(slot),
               'address': f'{base}.{slot}.2', 'gateway': f'{base}.{slot}.1',
               'prefix': 24, 'dns': os.environ.get('BOXERY_CH_DNS', '1.1.1.1').split()[0],
               'mac': f'52:54:00:77:{slot // 256:02x}:{slot % 256:02x}',
               'port': int(os.environ.get('BOXERY_CH_PORT_BASE', '22000')) + slot}
    if not 1024 <= network['port'] <= 65535:
        raise ValueError('SSH forwarding port out of range')
    binary = shutil.which('cloud-hypervisor')
    remote = shutil.which('ch-remote')
    if not binary or not remote:
        raise ValueError('cloud-hypervisor and ch-remote must be on PATH')
    config = {'version': VERSION, 'name': name, 'cpus': cpus, 'mem': mem, 'disk': disk,
              'network': network, 'binary': binary, 'remote': remote,
              'firmware': os.environ.get('BOXERY_CH_FIRMWARE', ''),
              'kernel': os.environ.get('BOXERY_CH_KERNEL', ''), 'initrd': os.environ.get('BOXERY_CH_INITRAMFS', ''),
              'agent': bool(template or image_meta), 'first': True, 'restore': bool(template),
              'restore_mode': os.environ.get('BOXERY_CH_RESTORE_MODE', 'copy')}
    if template or image_meta:
        profile = Path(template) if template else Path(json.loads(Path(image_meta).read_text())['template'])
        config['template'] = str(profile)
        if (profile / 'firmware').is_file():
            config['firmware'] = str(profile / 'firmware')
        else:  # pre-release disk-only images: keep their ordinary cold-boot compatibility
            config['kernel'], config['initrd'] = str(profile / 'vmlinuz'), str(profile / 'initrd')
        identity = json.loads(Path(str(seed) + '.json').read_text())
        manifest = json.loads((profile / 'manifest.json').read_text())
        if identity.get('kind') != manifest.get('kind'):
            raise ValueError('image/template kind does not match the requested VM')
        if identity.get('version') != VERSION or identity.get('name') != name:
            raise ValueError('missing or mismatched structured seed')
        atomic(directory / 'assignment.json', identity)
        if template:
            run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'raw', '-b', profile / 'disk.raw', directory / 'disk.qcow2'])
            (directory / 'restore').mkdir()
            os.link(profile / 'memory-ranges', directory / 'restore/memory-ranges')
            shutil.copyfile(profile / 'state.json', directory / 'restore/state.json')
            saved = json.loads((profile / 'config.json').read_text())
            saved['disks'][0].update(path=str(directory / 'disk.qcow2'), image_type='Qcow2', backing_files=True)
            saved['payload'] = {'firmware': config['firmware']}  # also honor guest GRUB/kernel updates on reboot
            saved['vsock']['socket'] = str(directory / 'vsock.sock')
            saved['serial'].update(mode='File', file=str(directory / 'serial.log'))
            atomic(directory / 'restore/config.json', saved)
        atomic(directory / 'fast.json', {'version': VERSION, 'template': str(profile)})
    if mode == 'passt':
        passt = os.environ.get('BOXERY_CH_PASST', 'passt')
        config['passt'] = shutil.which(passt)
        if not config['passt']:
            raise ValueError('passt executable not found')
    atomic(directory / 'runtime.json', config)


def rpc(path, request, timeout=30):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(path))
        stream = sock.makefile('rb')
        sock.sendall(f'CONNECT {PORT}\n'.encode())
        if not stream.readline(256).startswith(b'OK '):
            raise RuntimeError('vsock handshake failed')
        sock.sendall(json.dumps(request).encode() + b'\n')
        line = stream.readline(65536)
        if not line.endswith(b'\n'):
            raise RuntimeError('invalid assignment response')
        response = json.loads(line)
        if not response.get('ok'):
            raise RuntimeError(response.get('error', 'assignment rejected'))
        return response['result']


def net_args(config, directory):
    n = config['network']
    if n['mode'] == 'passt':
        return f"vhost_user=on,socket={directory}/net.sock,mac={n['mac']},num_queues=2,id=boxery-net"
    return f"tap={n.get('tap', 'bxch' + str(n['slot']))},mac={n['mac']},id=boxery-net"


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def serve(directory):
    config = json.loads((directory / 'runtime.json').read_text())
    if config.get('version') != VERSION or config.get('network', {}).get('mode') not in ('tap', 'passt'):
        raise ValueError('invalid persisted runtime configuration')
    process = passt = None
    (directory / 'ready').unlink(missing_ok=True)
    for name in ['api.sock', 'vsock.sock', 'net.sock']:
        (directory / name).unlink(missing_ok=True)
    try:
        n = config['network']
        if n['mode'] == 'passt':
            passt = subprocess.Popen([config['passt'], '--foreground', '--vhost-user', '--socket', str(directory / 'net.sock'),
                '--ipv4-only', '--address', n['address'], '--netmask', '24', '--gateway', n['gateway'],
                '--dns-forward', n['gateway'], '--dns-host', n['dns'], '--no-map-gw',
                '--tcp-ports', f"127.0.0.1/{n['port']}:22", '--udp-ports', 'none'])
            deadline = time.monotonic() + 10
            while not (directory / 'net.sock').exists():
                if passt.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('passt did not start (port collision or unsupported version)')
                time.sleep(0.01)
        restore = config['restore'] and config['first']
        args = [config['binary'], '--api-socket', str(directory / 'api.sock')]
        if restore:
            mode = config['restore_mode']
            if mode not in ('copy', 'copyonwrite') or (mode == 'copyonwrite' and n['mode'] == 'passt'):
                raise ValueError('COW restore requires TAP/private RAM; passt uses eager restore')
            args += ['--restore', f'source_url={(directory / "restore").as_uri()},memory_restore_mode={mode},resume=false']
        else:
            args += ['--cpus', f"boot={config['cpus']}", '--memory', f"size={config['mem']}M,shared={'on' if n['mode'] == 'passt' else 'off'}",
                     '--disk', f'path={directory}/disk.qcow2,image_type=qcow2,backing_files=on',
                     '--net', net_args(config, directory), '--vsock', f'cid=3,socket={directory}/vsock.sock',
                     '--serial', f'file={directory}/serial.log', '--console', 'off']
            if config['firmware'] and Path(config['firmware']).is_file():
                args += ['--firmware', config['firmware']]
            elif config['kernel']:
                args += ['--kernel', config['kernel'], '--initramfs', config['initrd'],
                         '--cmdline', 'root=LABEL=cloudimg-rootfs ro console=ttyS0 quiet']
            else:
                raise ValueError('a firmware or kernel/initramfs must be configured for cold boot')
            if (directory / 'seed.iso').exists():
                i = args.index('--net')
                args[i:i] = [f'path={directory}/seed.iso,readonly=on,image_type=raw']
        process = subprocess.Popen(args)
        remote = [config['remote'], '--api-socket', str(directory / 'api.sock')]
        deadline = time.monotonic() + 30
        while True:
            if process.poll() is not None:
                raise RuntimeError('VMM exited before its API became available')
            try:
                json.loads(run([*remote, 'info']))
                break
            except (subprocess.SubprocessError, ValueError):
                if time.monotonic() > deadline:
                    raise TimeoutError('VMM API did not start')
                time.sleep(0.01)
        if restore:
            run([*remote, 'add-net', net_args(config, directory)])
            run([*remote, 'resume'])
        assigned = not config['agent']
        boot_deadline = time.monotonic() + 90
        while process.poll() is None:
            if passt and passt.poll() is not None:
                raise RuntimeError('network helper exited')
            if config['agent']:
                try:
                    hello = rpc(directory / 'vsock.sock', {'action': 'hello'}, timeout=0.5)
                except (OSError, RuntimeError):
                    hello = None
                if hello:
                    if hello != {'version': VERSION, 'barrier': True}:
                        raise ValueError('unsupported guest assignment barrier')
                    identity = json.loads((directory / 'assignment.json').read_text()) if config['first'] else {'version': VERSION, 'name': config['name']}
                    identity.update(action='assign', fresh=config['first'], incarnation=secrets.token_hex(16),
                                    entropy=secrets.token_hex(64), time=time.time(), network=n)
                    response = rpc(directory / 'vsock.sock', identity)
                    if response.get('name') != config['name'] or response.get('incarnation') != identity['incarnation']:
                        raise ValueError('guest assignment acknowledgement mismatch')
                    config['first'] = False
                    atomic(directory / 'runtime.json', config)
                    atomic(directory / 'ready', {'incarnation': identity['incarnation']})
                    assigned = True
            if not assigned and time.monotonic() > boot_deadline:
                raise TimeoutError('guest never acknowledged assignment; refusing readiness')
            time.sleep(0.1 if not assigned else 0.5)
        if process.returncode:
            raise RuntimeError('VMM exited unsuccessfully')
    finally:
        stop(process)
        stop(passt)
        (directory / 'ready').unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    match = sub.add_parser('match')
    match.add_argument('root', type=Path)
    match.add_argument('kind', choices=['desktop', 'headless'])
    for key in ['cpus', 'mem', 'disk']:
        match.add_argument(key, type=int)
    match.add_argument('network', choices=['tap', 'passt'])
    conf = sub.add_parser('configure')
    conf.add_argument('directory', type=Path)
    conf.add_argument('name')
    for key in ['cpus', 'mem', 'disk', 'slot']:
        conf.add_argument(key, type=int)
    conf.add_argument('seed', type=Path)
    conf.add_argument('--template', type=Path)
    conf.add_argument('--image-meta', type=Path)
    serve_ = sub.add_parser('run')
    serve_.add_argument('directory', type=Path)
    args = parser.parse_args()
    if args.action == 'match':
        template = catalog(args.root, args.kind, args.cpus, args.mem, args.disk, args.network)
        if template is None:
            sys.exit(3)
        print(template)
    elif args.action == 'configure':
        configure(args.directory.resolve(), args.name, args.cpus, args.mem, args.disk, args.slot,
                  args.seed, args.template, args.image_meta)
    else:
        serve(args.directory.resolve())


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'boxery CH runtime: {e}', file=sys.stderr)
        sys.exit(1)
