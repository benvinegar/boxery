#!/usr/bin/env python3
"""Build a clean, immutable CH RAM template from a NEW disposable Boxery VM.

Source profile may use libvirt or CH. Never captures an existing user VM. The
builder uses its own lifecycle journal; published versions are never overwritten
or automatically deleted (including versions referenced by disk-only images).
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import signal
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

from runtime import VERSION, TEMPLATE_VERSION, atomic, barrier_id, cpu_id, rpc, run, stop
ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def source_config():
    script = """import {loadConfig,HOST_ENV} from './host/config.mjs'; import {loadShapes} from './host/shapes.mjs'; const c=loadConfig();
console.log(JSON.stringify({conf:c.conf,backend:c.backend,shapes:loadShapes(c.root,c.conf),env:Object.fromEntries(HOST_ENV.filter(k=>c.env[k]).map(k=>[k,c.env[k]]))}));"""
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--templates', type=Path, required=True)
    parser.add_argument('--firmware', type=Path, help='current EDK2 CLOUDHV.fd (or BOXERY_CH_FIRMWARE)')
    parser.add_argument('--shape', help='source profile shape (default: its default shape); size flags override it')
    parser.add_argument('--cpus', type=int)
    parser.add_argument('--mem', type=int)
    parser.add_argument('--disk', type=int)
    parser.add_argument('--kind', choices=['desktop', 'headless'], default='desktop')
    parser.add_argument('--network', choices=['tap', 'passt'], default='tap')
    parser.add_argument('--cold-base', type=Path, help='also export a NEW independent cold fallback base (refuses overwrite)')
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error('template building requires Python 3.11 or newer')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        parser.error('template builder currently supports x86_64 Linux')
    if args.cold_base and args.kind != 'desktop':
        parser.error('--cold-base exports the desktop fallback; build it from a desktop builder')
    config = source_config()
    label = args.shape or config['shapes']['default']
    if label not in config['shapes']['shapes']:
        parser.error('unknown source profile shape')
    for field in ['cpus', 'mem', 'disk']:
        if getattr(args, field) is None:
            setattr(args, field, config['shapes']['shapes'][label][field])
    if min(args.cpus, args.mem, args.disk) < 1 or args.mem < 512:
        parser.error('positive sizes and at least 512 MiB RAM are required')
    if config['backend'] not in ('libvirt', 'cloud-hypervisor'):
        parser.error('use a local libvirt or CH source profile with a prepared base')
    binary, remote = shutil.which('cloud-hypervisor'), shutil.which('ch-remote')
    if not binary or not remote:
        parser.error('cloud-hypervisor v54+ and ch-remote must be on PATH')
    import re
    reported = run([binary, '--version'])
    match = re.search(r'v([0-9]+)', reported)
    if not match or int(match[1]) < 54:
        parser.error('Cloud Hypervisor v54 or newer is required')
    firmware = args.firmware or Path(os.environ.get('BOXERY_CH_FIRMWARE') or config['env'].get('BOXERY_CH_FIRMWARE', '/nonexistent'))
    if not firmware.is_file():
        parser.error('provide --firmware pointing to current EDK2 CLOUDHV.fd; firmware boot preserves guest kernel updates')
    templates = args.templates.resolve()
    if any(c.isspace() or c in ',=' for c in str(templates)):
        parser.error('template path cannot contain whitespace, commas or equals signs')
    templates.mkdir(mode=0o700, parents=True, exist_ok=True)
    (templates / 'versions').mkdir(exist_ok=True)
    (templates / 'index').mkdir(exist_ok=True)
    version = secrets.token_hex(16)
    work, final = templates / ('.build-' + version), templates / 'versions' / version
    work.mkdir(mode=0o700)
    shutil.copyfile(firmware, work / 'firmware')
    private = work / 'builder-conf'
    private.mkdir(mode=0o700)
    builder = 'bt-' + secrets.token_hex(5)
    prefix = 'bxram-' + secrets.token_hex(4) + '-'
    env = {**os.environ, **config['env'], 'BOXERY_CONF': str(private), 'BOXERY_BACKEND': config['backend'],
           'BOXERY_DOMAIN_PREFIX': prefix}
    atomic(work / 'build.json', {'source_conf': str(private), 'builder': builder, 'prefix': prefix, 'backend': config['backend']})
    source = Path(config['conf'])
    for f in ['mgmt_ed25519', 'mgmt_ed25519.pub']:
        shutil.copyfile(source / f, private / f)
        (private / f).chmod(0o600)
    (private / 'host.env').write_text(''.join(f'{k}={v}\n' for k, v in config['env'].items()
                                             if k != 'BOXERY_DOMAIN_PREFIX') +
                                      f'BOXERY_DOMAIN_PREFIX={prefix}\n')
    host = ROOT / 'host/boxery-host'
    process = log = None
    created = False
    cleaned = True
    agent_source = (HERE / 'guest.py').read_bytes()
    prepare_source = (HERE / 'prepare-guest.sh').read_bytes()

    def host_run(argv):
        return subprocess.run([str(host), *argv], env=env, check=True, capture_output=True, text=True).stdout.strip()

    def virsh(*argv):
        return run(['virsh', '-c', env.get('LIBVIRT_DEFAULT_URI', 'qemu:///system'), *argv])

    try:
        created = True
        print(f'Creating disposable builder {builder} ({config["backend"]})', flush=True)
        command = ['new', builder, '--cold', '--cpus', str(args.cpus), '--mem', str(args.mem), '--disk', str(args.disk)]
        if args.kind == 'headless':
            command.append('--headless')
        endpoint = host_run(command).split()[1]
        address, port = endpoint.rsplit(':', 1)
        ssh = ['ssh', '-i', str(private / 'mgmt_ed25519'), '-p', port, '-o', 'IdentitiesOnly=yes',
               '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', 'agent@' + address]
        if run([*ssh, 'hostname']) != builder:
            raise ValueError('builder endpoint identity mismatch')
        if run([*ssh, 'findmnt -n -o FSTYPE /']) != 'ext4' or run([*ssh, 'findmnt -n -o SOURCE /']) != '/dev/vda1':
            raise ValueError('fast templates currently require the Ubuntu ext4 root on /dev/vda1')
        # Refresh Boxery's own plumbing even when the installed golden image predates current
        # service names. This is a new disposable builder, never an upgrade of a useful VM.
        run([*ssh, 'sudo mkdir -p /usr/local/lib/boxery/layers'])
        for layer in ['lib', 'plumbing', 'devtools', 'desktop', 'provision']:
            destination = '/usr/local/sbin/boxery-provision' if layer == 'provision' else f'/usr/local/lib/boxery/layers/{layer}.sh'
            subprocess.run([*ssh, f'sudo tee {destination} >/dev/null'], input=(ROOT / 'image/layers' / (layer + '.sh')).read_bytes(), check=True)
        layers = 'plumbing devtools desktop' if args.kind == 'desktop' else 'plumbing devtools'
        run([*ssh, 'set -e; sudo chmod 755 /usr/local/sbin/boxery-provision; '
             'sudo systemctl disable --now agentvm-llm.service 2>/dev/null || true; '
             f'sudo /usr/local/sbin/boxery-provision {layers}; '
             'sudo rm -f /home/agent/.config/systemd/user/default.target.wants/agentvm-vnc.service '
             '/home/agent/.config/systemd/user/default.target.wants/agentvm-desktop.service '
             '/home/agent/.config/systemd/user/default.target.wants/agentvm-novnc.service'])
        if args.cold_base:
            # A conventional cold base must initialize PID 1's cached machine-id afresh too.
            # Keep the live builder's SSH access until its final prepare step; clone cloud-init
            # regenerates host keys and replaces authorized_keys before SSH becomes usable.
            run([*ssh, 'set -e; sudo cloud-init clean --logs --seed; sudo truncate -s 0 /etc/machine-id; '
                 'sudo rm -f /var/lib/dbus/machine-id /home/agent/.boxery/token /home/agent/.pi/agent/models.json '
                 '/home/agent/.config/opencode/opencode.json; sync'])
            host_run(['snap', builder, 'fast-cold-base'])
            # RAM-template boot needs a regular nonempty file, not systemd's transient RO mount.
            run([*ssh, 'sudo systemd-machine-id-setup'])
        subprocess.run([*ssh, 'sudo tee /usr/local/sbin/boxery-fast-agent.py >/dev/null'], input=agent_source, check=True)
        subprocess.run([*ssh, 'sudo bash -s'], input=prepare_source, check=True)
        host_run(['stop', builder])
        deadline = time.monotonic() + 60
        if config['backend'] == 'libvirt':
            domain = prefix + builder
            while virsh('domstate', domain) != 'shut off':
                if time.monotonic() > deadline:
                    raise TimeoutError('builder shutdown timed out')
                time.sleep(0.2)
            xml = ET.fromstring(virsh('dumpxml', domain))
            disk = next(d for d in xml.findall('./devices/disk') if d.get('device') == 'disk')
            pool = env.get('BOXERY_POOL', 'boxery')
            virsh('vol-download', '--pool', pool, Path(disk.find('source').get('file')).name, str(work / 'builder.qcow2'))
            info = json.loads(run(['qemu-img', 'info', '--output=json', work / 'builder.qcow2']))
            backing = Path(info['backing-filename']).name
            virsh('vol-download', '--pool', pool, backing, str(work / 'base.qcow2'))
            if json.loads(run(['qemu-img', 'info', '--output=json', work / 'base.qcow2'])).get('backing-filename'):
                raise ValueError('builder export requires a one-level root image')
            run(['qemu-img', 'rebase', '-u', '-f', 'qcow2', '-F', 'qcow2', '-b', work / 'base.qcow2', work / 'builder.qcow2'])
            source_disk = work / 'builder.qcow2'
            cold_base = work / 'base.qcow2'
            if args.cold_base:
                cold_base = work / 'cold-overlay.qcow2'
                virsh('vol-download', '--pool', pool, prefix + builder + '@fast-cold-base.qcow2', str(cold_base))
                run(['qemu-img', 'rebase', '-u', '-f', 'qcow2', '-F', 'qcow2', '-b', work / 'base.qcow2', cold_base])
        else:
            ch_dir = Path(env.get('BOXERY_CH_DIR', str(Path.home() / '.local/share/boxery/ch')))
            source_disk = ch_dir / 'vms' / builder / 'disk.qcow2'
            cold_base = ch_dir / 'images' / (builder + '@fast-cold-base.qcow2') if args.cold_base else ch_dir / 'base.qcow2'
            while any(v['name'] == builder and v['state'] == 'running' for v in json.loads(host_run(['ls', '--json']))):
                if time.monotonic() > deadline:
                    raise TimeoutError('builder shutdown timed out')
                time.sleep(0.2)
        run(['qemu-img', 'convert', '-f', 'qcow2', '-O', 'raw', source_disk, work / 'disk.raw'])
        if args.cold_base:
            target = args.cold_base.resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            part = target.with_name(target.name + '.' + version + '.part')
            try:
                run(['qemu-img', 'convert', '-O', 'qcow2', cold_base, part])
                os.link(part, target)  # refuse overwrite, including a concurrently published base
            finally:
                part.unlink(missing_ok=True)
        (work / 'source').mkdir()
        log = open(work / 'source/vmm.log', 'w')
        parent = os.getpid()

        def parent_death():
            ctypes.CDLL(None).prctl(1, signal.SIGTERM)
            if os.getppid() != parent:
                os.kill(os.getpid(), signal.SIGTERM)

        process = subprocess.Popen([str(a) for a in [binary, '--api-socket', work / 'source/api.sock',
            '--cpus', f'boot={args.cpus}', '--memory', f"size={args.mem}M,shared={'on' if args.network == 'passt' else 'off'}",
            '--firmware', work / 'firmware',
            '--disk', f'path={work}/disk.raw,image_type=raw', '--vsock', f'cid=3,socket={work}/source/vsock.sock',
            '--serial', f'file={work}/source/serial.log', '--console', 'off']], stdout=log, stderr=log, preexec_fn=parent_death)
        deadline = time.monotonic() + 45
        while True:
            if process.poll() is not None:
                raise RuntimeError('template VMM exited; see source/vmm.log')
            try:
                hello = rpc(work / 'source/vsock.sock', {'action': 'hello'}, timeout=1)
                if hello != {'version': VERSION, 'barrier': True}:
                    raise ValueError('unexpected assignment agent')
                break
            except (OSError, RuntimeError):
                if time.monotonic() > deadline:
                    raise TimeoutError('template assignment barrier did not start; inspect source/serial.log')
                time.sleep(0.05)
        time.sleep(1)
        (work / 'snapshot').mkdir()
        control = [remote, '--api-socket', work / 'source/api.sock']
        run([*control, 'pause'])
        run([*control, 'snapshot', (work / 'snapshot').as_uri()])
        stop(process)
        process = None
        # Source never resumes: preserve the exact paired disk, not a later live disk copy.
        for file in ['config.json', 'state.json', 'memory-ranges']:
            shutil.move(work / 'snapshot' / file, work / file)
        saved = json.loads((work / 'config.json').read_text())
        saved['disks'][0]['path'] = str(final / 'disk.raw')
        saved['payload'] = {'firmware': str(final / 'firmware')}
        atomic(work / 'config.json', saved)
        files = {}
        for file in ['disk.raw', 'memory-ranges', 'config.json', 'state.json', 'firmware']:
            with open(work / file, 'rb') as f:
                digest = hashlib.file_digest(f, 'sha256').hexdigest()
            files[file] = {'size': (work / file).stat().st_size, 'sha256': digest}
            (work / file).chmod(0o400)
        atomic(work / 'manifest.json', {'version': TEMPLATE_VERSION, 'id': version, 'kind': args.kind, 'cpus': args.cpus,
            'mem': args.mem, 'disk': args.disk, 'network': args.network, 'arch': platform.machine(),
            'cpu': cpu_id(), 'agent': barrier_id(agent_source, prepare_source), 'hypervisor': reported, 'files': files})
        host_run(['rm', builder])
        created = False
        shutil.rmtree(private)
        for name in ['source', 'snapshot']:
            shutil.rmtree(work / name)
        for name in ['base.qcow2', 'builder.qcow2', 'cold-overlay.qcow2', 'build.json']:
            (work / name).unlink(missing_ok=True)
        os.rename(work, final)
        key = f'{args.kind}-{args.cpus}-{args.mem}-{args.disk}-{args.network}.json'
        atomic(templates / 'index' / key, {'id': version})
        print(f'Published immutable template {version} in {templates}', flush=True)
    finally:
        stop(process)
        if log:
            log.close()
        if created:
            try:
                host_run(['rm', builder])
            except Exception:
                cleaned = False
                print(f'Builder cleanup needs recovery: BOXERY_CONF={private} BOXERY_DOMAIN_PREFIX={prefix} {host} rm {builder}', file=sys.stderr)
        for name in ['mgmt_ed25519', 'mgmt_ed25519.pub']:
            (private / name).unlink(missing_ok=True)
        if cleaned and private.exists():
            shutil.rmtree(private)


if __name__ == '__main__':
    main()
