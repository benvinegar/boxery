#!/usr/bin/env python3
"""LOCAL EXPERIMENT ONLY: root guest control over vsock, never a production API.

The template has no assignment secret. Assignment reseeds the kernel RNG and
creates new instance credentials before commands are accepted. RAM restore still
clones boot_id and potentially service-cached machine IDs/userspace RNG state;
this experiment deliberately does not claim production-safe arbitrary VM forks.
"""
import fcntl
import hmac
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import urllib.request
import uuid

PORT = 19090
STATE = Path('/run/boxery-ram')
STATE.mkdir(mode=0o700, exist_ok=True)
secret = None
instance = None


def reseed(entropy):
    if len(entropy) != 64:
        raise ValueError('64 bytes of host entropy required')
    with open('/dev/urandom', 'rb', buffering=0) as rng:
        fcntl.ioctl(rng, 0x40085203, struct.pack('ii', len(entropy) * 8, len(entropy)) + entropy)
        fcntl.ioctl(rng, 0x5207)


def command(argv, timeout=20):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f'{argv[0]} exited {p.returncode}: {p.stderr[-2000:]}')
    return p.stdout


def http(url):
    with urllib.request.urlopen(url, timeout=2) as r:
        return r.status, r.read().decode()


def probe():
    status, _ = http('http://127.0.0.1:6080/vnc.html')
    _, version = http('http://127.0.0.1:9222/json/version')
    shell = command(['sudo', '-u', 'agent', 'bash', '-lc', 'printf shell-ok; test -d ~/project'])
    marker = Path('/home/agent/project/ram-template-marker')
    return {
        'instance': instance, 'shell': shell, 'novnc': status,
        'browser': json.loads(version).get('Browser'),
        'random': os.urandom(32).hex(),
        'machine_id': Path('/etc/machine-id').read_text().strip(),
        'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
        'marker': marker.read_text() if marker.exists() else None,
    }


def handle(req):
    global secret, instance
    action = req.get('action')
    if action == 'hello':
        return {'assigned': secret is not None, 'pid': os.getpid()}
    if action == 'prepare':
        if secret is not None:
            raise ValueError('assigned VMs cannot become templates')
        result = probe()
        if result['marker'] is not None:
            raise ValueError('template has a writable marker')
        for file in ['/home/agent/.boxery/token', '/home/agent/.ssh/authorized_keys']:
            if Path(file).exists():
                raise ValueError('template has Boxery credentials or SSH access')
        command(['sync'])
        return result
    if action == 'assign':
        if secret is not None:
            raise ValueError('already assigned')
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', req.get('instance', '')):
            raise ValueError('invalid instance')
        if not re.fullmatch(r'[0-9a-f]{64}', req.get('secret', '')):
            raise ValueError('invalid secret')
        reseed(bytes.fromhex(req['entropy']))
        command(['hostname', req['instance']])
        Path('/etc/machine-id').write_text(uuid.uuid4().hex + '\n')
        # These are experiment credentials, not real Boxery proxy credentials.
        identity = {'instance': req['instance'], 'secret': req['secret']}
        fd = os.open(STATE / 'identity.json', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(identity, f)
        instance, secret = req['instance'], req['secret']
        return {'assigned': True, 'instance': instance}
    if secret is None or not hmac.compare_digest(str(req.get('secret', '')), secret):
        raise PermissionError('unassigned or incorrect instance secret')
    if action == 'probe':
        return probe()
    if action == 'write-marker':
        marker = Path('/home/agent/project/ram-template-marker')
        marker.write_text(str(req['value']))
        return {'marker': marker.read_text()}
    if action == 'screenshot':
        script = """const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = ({data}) => {
 const msg = JSON.parse(data), item = pending.get(msg.id);
 if (!item) return;
 pending.delete(msg.id);
 if (msg.error) item.reject(new Error(JSON.stringify(msg.error))); else item.resolve(msg.result);
};
const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
 const id = ++seq; pending.set(id, {resolve, reject}); ws.send(JSON.stringify({id, method, params, sessionId}));
});
try {
 const {targetId} = await call('Target.createTarget', {url: 'about:blank'});
 const {sessionId} = await call('Target.attachToTarget', {targetId, flatten: true});
 await call('Runtime.evaluate', {expression: 'document.body.innerHTML = ' + JSON.stringify('<h1>RAM template clone</h1><p>' + process.argv[1] + '</p>')}, sessionId);
 const {data} = await call('Page.captureScreenshot', {format: 'png'}, sessionId);
 console.log(data);
 await call('Target.closeTarget', {targetId});
} finally { ws.close(); }
"""
        png = command(['sudo', '-u', 'agent', 'node', '--input-type=module', '-e', script, instance])
        return {'png': png.strip()}
    raise ValueError('unknown action')


server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
server.bind((socket.VMADDR_CID_ANY, PORT))
server.listen(16)
while True:
    conn, _ = server.accept()
    with conn:
        conn.settimeout(30)
        try:
            data = bytearray()
            while b'\n' not in data:
                block = conn.recv(4096)
                if not block:
                    raise ValueError('incomplete request')
                data.extend(block)
                if len(data) > 65536:
                    raise ValueError('request too large')
            result = handle(json.loads(data.split(b'\n', 1)[0]))
            response = {'ok': True, 'result': result}
        except Exception as e:
            response = {'ok': False, 'error': str(e)}
        conn.sendall(json.dumps(response).encode() + b'\n')
