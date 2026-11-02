#!/usr/bin/env python3
"""Prepare a LOCAL EXPERIMENT ONLY Cloud Hypervisor desktop RAM template.

Requires an initialized x86_64 Linux libvirt Boxery host with an existing desktop
base. Creates/removes one isolated builder, downloads pinned CH binaries, and
exports a private copy of its disk. Never modifies the shared base or network.
See README.md before use. Needs ~12 GiB free during preparation (~8 GiB after).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET

from bench import rpc, run

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
ASSETS = {
    'cloud-hypervisor': ('cloud-hypervisor-static', '4f4f98a3d661a40f3e5272627cc895a1b2e525f2f6bedf5f895f9cd21ba5c65b'),
    'ch-remote': ('ch-remote-static', 'acd5be240d5c73373effbe818908fc03e313ec8486237904bff11d93b71b1c83'),
}


def host_config():
    script = """import {loadConfig,HOST_ENV} from './host/config.mjs';
const c=loadConfig(); console.log(JSON.stringify({conf:c.conf,backend:c.backend,
 env:Object.fromEntries(HOST_ENV.filter(k=>c.env[k]).map(k=>[k,c.env[k]]))}));"""
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, required=True, help='new directory; use disk-backed storage for cache experiments')
    parser.add_argument('--settle-seconds', type=float, default=5,
                        help='allow boot/browser background initialization to settle before capturing (default 5)')
    args = parser.parse_args()
    if not 0 <= args.settle_seconds <= 60:
        parser.error('--settle-seconds must be between 0 and 60')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        parser.error('this experiment currently supports x86_64 Linux only')
    work = args.work_dir.resolve()
    if any(c.isspace() or c in ',=' for c in str(work)):
        parser.error('choose a path without whitespace, commas or equals signs')
    config = host_config()
    if config['backend'] != 'libvirt':
        parser.error('template preparation requires a configured libvirt host')
    conf = Path(config['conf'])
    for f in ['mgmt_ed25519', 'mgmt_ed25519.pub']:
        if not (conf / f).is_file():
            parser.error('initialize the Boxery host/management key first')
    work.mkdir(mode=0o700)  # refusing an existing path avoids overwriting someone else's template
    private = work / 'builder-conf'
    private.mkdir(mode=0o700)
    prefix = 'bxram-' + secrets.token_hex(4) + '-'
    env = {**os.environ, **config['env'], 'BOXERY_CONF': str(private), 'BOXERY_DOMAIN_PREFIX': prefix, 'BOXERY_BACKEND': 'libvirt'}
    (private / 'host.env').write_text(''.join(f'{k}={v}\n' for k, v in config['env'].items() if k != 'BOXERY_DOMAIN_PREFIX') + f'BOXERY_DOMAIN_PREFIX={prefix}\n')
    host = ROOT / 'host/boxery-host'
    uri = env.get('LIBVIRT_DEFAULT_URI', 'qemu:///system')
    pool = env.get('BOXERY_POOL', 'boxery')
    base_vol = env.get('BOXERY_BASE_VOL', 'boxery-base.qcow2')
    builder = prefix + 'builder'
    child = None
    log = None
    created = False
    cleaned = True

    def host_run(argv):
        return subprocess.run([str(host), *argv], env=env, check=True, capture_output=True, text=True).stdout.strip()

    def virsh(*argv):
        return run(['virsh', '-c', uri, *argv]).strip()

    try:
        for f in ['mgmt_ed25519', 'mgmt_ed25519.pub']:
            shutil.copyfile(conf / f, private / f)
            (private / f).chmod(0o600)
        (work / 'bin').mkdir()
        for name, (asset, expected) in ASSETS.items():
            destination = work / 'bin' / name
            url = f'https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v54.0/{asset}'
            urllib.request.urlretrieve(url, destination)
            with open(destination, 'rb') as f:
                actual = hashlib.file_digest(f, 'sha256').hexdigest()
            if actual != expected:
                raise RuntimeError(f'checksum mismatch: {asset}')
            destination.chmod(0o755)
        created = True
        print(f'Creating isolated builder {builder}', flush=True)
        endpoint = host_run(['new', 'builder', '--cpus', '2', '--mem', '2048', '--disk', '20'])
        address = endpoint.split()[1].rsplit(':', 1)[0]
        ssh = ['ssh', '-i', str(private / 'mgmt_ed25519'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
               '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', f'agent@{address}']
        for source, destination in [('/boot/vmlinuz', 'vmlinuz'), ('/boot/initrd.img', 'initrd')]:
            with open(work / destination, 'wb') as f:
                subprocess.run([*ssh, f'sudo dd if={source} status=none'], stdout=f, check=True)
        subprocess.run([*ssh, 'sudo tee /usr/local/sbin/ram-template-agent.py >/dev/null'],
                       input=(HERE / 'guest-agent.py').read_bytes(), check=True)
        subprocess.run([*ssh, 'sudo bash -s'], input=(HERE / 'prepare-guest.sh').read_bytes(), check=True)
        xml = ET.fromstring(virsh('dumpxml', builder))
        disk = next(d for d in xml.findall('./devices/disk') if d.get('device') == 'disk')
        volume = Path(disk.find('source').get('file')).name
        virsh('shutdown', builder)
        deadline = time.monotonic() + 60
        while virsh('domstate', builder) != 'shut off':
            if time.monotonic() > deadline:
                raise TimeoutError('builder did not shut down')
            time.sleep(0.2)
        virsh('vol-download', '--pool', pool, volume, str(work / 'builder.qcow2'))
        virsh('vol-download', '--pool', pool, base_vol, str(work / 'base.qcow2'))
        base_info = json.loads(run(['qemu-img', 'info', '--output=json', work / 'base.qcow2']))
        disk_info = json.loads(run(['qemu-img', 'info', '--output=json', work / 'builder.qcow2']))
        if base_info.get('backing-filename') or Path(disk_info.get('backing-filename', '')).name != base_vol:
            raise ValueError('preparation currently requires a one-level overlay on the configured base')
        run(['qemu-img', 'rebase', '-u', '-f', 'qcow2', '-F', 'qcow2', '-b', work / 'base.qcow2', work / 'builder.qcow2'])
        run(['qemu-img', 'convert', '-f', 'qcow2', '-O', 'raw', work / 'builder.qcow2', work / 'template-root.raw'])
        (work / 'source').mkdir()
        log = open(work / 'source/vmm.log', 'w')
        child = subprocess.Popen([str(a) for a in [work / 'bin/cloud-hypervisor',
            '--api-socket', work / 'source/api.sock', '--cpus', 'boot=2', '--memory', 'size=2048M',
            '--kernel', work / 'vmlinuz', '--initramfs', work / 'initrd',
            '--cmdline', 'root=LABEL=cloudimg-rootfs ro console=ttyS0 quiet',
            '--disk', f'path={work}/template-root.raw,image_type=raw',
            '--vsock', f'cid=3,socket={work}/source/vsock.sock',
            '--serial', f'file={work}/source/serial.log', '--console', 'off']], stdout=log, stderr=log)
        deadline = time.monotonic() + 40
        while True:
            if child.poll() is not None:
                raise RuntimeError('source VMM exited: ' + (work / 'source/vmm.log').read_text())
            try:
                prepared = rpc(work / 'source/vsock.sock', {'action': 'prepare'}, timeout=1)
                break
            except (OSError, RuntimeError, ValueError):
                if time.monotonic() > deadline:
                    raise TimeoutError('source template did not become ready')
                time.sleep(0.05)
        # A responsive browser can still be doing startup work. Capturing it too early reproduces
        # those writes/page faults in every clone. This delay is template-build time, not allocation.
        time.sleep(args.settle_seconds)
        prepared = rpc(work / 'source/vsock.sock', {'action': 'prepare'})
        (work / 'snapshot').mkdir()
        remote = [work / 'bin/ch-remote', '--api-socket', work / 'source/api.sock']
        run([*remote, 'pause'])
        start = time.perf_counter()
        run([*remote, 'snapshot', (work / 'snapshot').as_uri()])
        capture_ms = round((time.perf_counter() - start) * 1000, 2)
        # The source NEVER resumes. Its disk is exactly the disk paired with the saved RAM.
        child.terminate()
        child.wait(timeout=5)
        child = None
        (work / 'template-root.raw').chmod(0o400)
        (work / 'snapshot/memory-ranges').chmod(0o400)
        (work / 'manifest.json').write_text(json.dumps({'cloud_hypervisor': 'v54.0', 'cpus': 2,
            'mem_mib': 2048, 'capture_ms': capture_ms, 'settle_seconds': args.settle_seconds, 'prepared': prepared,
            'limitations': ['no external networking', 'boot_id and service-cached identity may be duplicated',
                            'experimental credentials, not Boxery proxy/lease integration']}, indent=2) + '\n')
        (work / 'base.qcow2').unlink()
        (work / 'builder.qcow2').unlink()
        print(f'Template prepared in {work}; RAM snapshot capture {capture_ms} ms', flush=True)
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        if log:
            log.close()
        if created:
            try:
                host_run(['rm', 'builder'])
            except Exception as e:
                cleaned = False
                print(f'Builder cleanup failed: {e}. Retaining {private} for recovery.', flush=True)
        # Never leave a copied host private key in a benchmark directory.
        for f in ['mgmt_ed25519', 'mgmt_ed25519.pub']:
            (private / f).unlink(missing_ok=True)
        if cleaned:
            shutil.rmtree(private)


if __name__ == '__main__':
    main()
