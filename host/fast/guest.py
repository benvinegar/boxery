#!/usr/bin/env python3
"""Restore-aware, one-shot assignment barrier. Root inside the guest only.

The only caller is the trusted host through its private CH Unix/vsock socket.
No generic command/file API is exposed. No user services start before assignment.
Ordinary user images remain disk-only; their cold boots also pass this barrier.
"""
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import socket
import struct
import subprocess
import time
import uuid

PORT = 19091
HOME = Path('/home/agent')
IDENTITY = Path('/etc/boxery/identity.json')
ALLOWED = {'.boxery/token', '.pi/agent/models.json', '.pi/agent/settings.json', '.config/opencode/opencode.json'}


def run(argv, check=True):
    return subprocess.run(argv, check=check, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=30, text=True)


def atomic(file, data, mode=0o600, owner=None):
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.is_relative_to(HOME) and not file.parent.resolve().is_relative_to(HOME.resolve()):
        raise ValueError('identity directory escapes agent home')
    temp = file.with_name('.' + file.name + '-' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(data)
            if owner:
                os.fchown(f.fileno(), *owner)
        os.replace(temp, file)
    finally:
        temp.unlink(missing_ok=True)


def validate(req):
    if req.get('version') != 1 or not isinstance(req.get('fresh'), bool):
        raise ValueError('unsupported assignment')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', req.get('name', '')):
        raise ValueError('invalid instance name')
    if not re.fullmatch(r'[0-9a-f]{32}', req.get('incarnation', '')):
        raise ValueError('invalid incarnation')
    if not re.fullmatch(r'[0-9a-f]{128}', req.get('entropy', '')):
        raise ValueError('invalid entropy')
    if not isinstance(req.get('time'), (int, float)) or not 1_700_000_000 < req['time'] < 4_000_000_000:
        raise ValueError('invalid clock')
    if req['fresh']:
        if req.get('kind') not in ('desktop', 'headless'):
            raise ValueError('invalid kind')
        keys = req.get('keys')
        if not isinstance(keys, list) or not 1 <= len(keys) <= 256 or any(
            not isinstance(k, str) or len(k) > 16384 or '\n' in k or '\r' in k or '\0' in k or
            not re.match(r'^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+(?: |$)', k) for k in keys):
            raise ValueError('invalid SSH keys')
        files = req.get('files')
        if not isinstance(files, list) or {f[0] for f in files if isinstance(f, list) and len(f) == 2} != ALLOWED:
            raise ValueError('invalid credential files')
        if len(files) != len(ALLOWED) or any(not isinstance(f[1], str) or len(f[1]) > 262144 for f in files):
            raise ValueError('invalid credential data')
        if not re.fullmatch(r'VSOCK-CONNECT:2:[0-9]{1,5}', req.get('upstream', '')) or not 1 <= int(req['upstream'].rsplit(':', 1)[1]) <= 65535:
            raise ValueError('invalid proxy upstream')
    net = req.get('network')
    if not isinstance(net, dict) or not re.fullmatch(r'52:54:00:(?:[0-9a-f]{2}:){2}[0-9a-f]{2}', net.get('mac', '')):
        raise ValueError('invalid network')
    import ipaddress
    for key in ('address', 'gateway', 'dns'):
        ipaddress.IPv4Address(net[key])
    if net.get('prefix') != 24:
        raise ValueError('invalid network prefix')


def assign(req):
    validate(req)  # validate the complete request before any side effects
    entropy = bytes.fromhex(req['entropy'])
    with open('/dev/urandom', 'rb', buffering=0) as f:
        fcntl.ioctl(f, 0x40085203, struct.pack('ii', 512, 64) + entropy)
        fcntl.ioctl(f, 0x5207)
    time.clock_settime(time.CLOCK_REALTIME, req['time'])
    user = pwd.getpwnam('agent')
    owner = (user.pw_uid, user.pw_gid)
    if req['fresh']:
        # All ordinary services are still stopped. PID 1 re-execs after changing machine-id;
        # D-Bus, sshd, logind, the user manager and applications start only afterwards.
        atomic(Path('/etc/machine-id'), uuid.uuid4().hex + '\n', 0o444)
        dbus_id = Path('/var/lib/dbus/machine-id')
        dbus_id.unlink(missing_ok=True)
        dbus_id.symlink_to('/etc/machine-id')
        run(['systemctl', 'daemon-reexec'])
        run(['systemctl', 'try-restart', 'systemd-journald.service'])
        atomic(Path('/etc/hostname'), req['name'] + '\n', 0o644)
        run(['hostname', req['name']])
        atomic(Path('/etc/hosts'), '127.0.0.1 localhost\n127.0.1.1 ' + req['name'] + '\n::1 localhost ip6-localhost\n', 0o644)
        sshdir = HOME / '.ssh'
        sshdir.mkdir(exist_ok=True)
        os.chmod(sshdir, 0o700)
        os.chown(sshdir, *owner)
        atomic(sshdir / 'authorized_keys', '\n'.join(req['keys']) + '\n', owner=owner)
        for file, data in req['files']:
            atomic(HOME / file, data, owner=owner)
        for directory in [HOME / '.boxery', HOME / '.pi', HOME / '.pi/agent', HOME / '.config', HOME / '.config/opencode']:
            os.chown(directory, *owner)
        atomic(Path('/etc/boxery/proxy-upstream'), req['upstream'] + '\n', 0o644)
        for key in Path('/etc/ssh').glob('ssh_host_*'):
            key.unlink()
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', '/etc/ssh/ssh_host_ed25519_key'])
        atomic(IDENTITY, json.dumps({'version': 1, 'name': req['name'], 'kind': req['kind']}))
    else:
        stored = json.loads(IDENTITY.read_text())
        if stored.get('name') != req['name']:
            raise ValueError('disk identity does not match this VM')
        run(['hostname', req['name']])
    atomic(Path('/run/boxery/incarnation'), req['incarnation'] + '\n', 0o444)
    net = req['network']
    deadline = time.monotonic() + 15
    while True:
        devices = [p.name for p in Path('/sys/class/net').iterdir()
                   if (p / 'address').read_text().strip().lower() == net['mac']]
        if devices:
            break
        if time.monotonic() > deadline:
            raise TimeoutError('network device did not appear')
        time.sleep(0.02)
    interface = devices[0]
    run(['ip', 'link', 'set', interface, 'up'])
    run(['ip', 'addr', 'replace', f"{net['address']}/{net['prefix']}", 'dev', interface])
    run(['ip', 'route', 'replace', 'default', 'via', net['gateway'], 'dev', interface])
    run(['resolvectl', 'dns', interface, net['dns']], check=False)
    # systemd-resolved may not be running at the barrier. Persist per-boot networkd configuration
    # before multi-user.target starts it; this also keeps DNS/routes correct after ordinary reboot.
    atomic(Path('/etc/systemd/network/05-boxery-fast.network'),
           f"[Match]\nMACAddress={net['mac']}\n[Network]\nAddress={net['address']}/24\nGateway={net['gateway']}\nDNS={net['dns']}\nIPv6AcceptRA=no\nLinkLocalAddressing=no\n", 0o644)
    run(['growpart', '/dev/vda', '1'], check=False)
    run(['resize2fs', '/dev/vda1'])
    return {'version': 1, 'name': req['name'], 'incarnation': req['incarnation']}


def main():
    marker = Path('/etc/boxery/fast-template')
    if os.geteuid() != 0 or not marker.is_file() or marker.read_text().strip() != str(1):
        raise RuntimeError('this service may run only in a prepared Boxery guest')
    if run(['systemctl', 'is-active', '--quiet', 'multi-user.target'], check=False).returncode == 0:
        raise RuntimeError('refusing assignment while user services are active')
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, PORT))
    server.listen(4)
    released = False
    while not released:
        conn, _ = server.accept()
        with conn:
            conn.settimeout(45)
            try:
                stream = conn.makefile('rb')
                line = stream.readline(2 * 1024 * 1024)
                if not line.endswith(b'\n'):
                    raise ValueError('invalid request size')
                req = json.loads(line)
                if req.get('action') == 'hello':
                    result = {'version': 1, 'barrier': True}
                elif req.get('action') == 'assign':
                    result = assign(req)
                    released = True
                else:
                    raise ValueError('unknown action')
                response = {'ok': True, 'result': result}
            except Exception as e:
                # Never echo credential contents, subprocess argv or an entire request.
                response = {'ok': False, 'error': type(e).__name__ + ': assignment failed'}
            try:
                conn.sendall(json.dumps(response).encode() + b'\n')
            except OSError:
                pass
    server.close()
    # Acknowledgement precedes release. There is no privileged root RPC listener during workloads.
    run(['systemctl', '--no-block', 'isolate', 'multi-user.target'])


if __name__ == '__main__':
    main()
