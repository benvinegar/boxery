"""Run a command with a real controlling terminal and answer only after its prompt."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time

answer, *command = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
output = b""
sent = False
end = time.monotonic() + 15
while True:
    if time.monotonic() > end:
        os.kill(pid, signal.SIGKILL)
        raise RuntimeError("grant command timed out: " + output.decode(errors="replace"))
    ready, _, _ = select.select([fd], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise
    if not chunk:
        break
    output += chunk
    if not sent and b"Allow access? [y/N] " in output:
        os.write(fd, (answer + "\n").encode())
        sent = True
_, status = os.waitpid(pid, 0)
os.close(fd)
print(json.dumps({"code": os.waitstatus_to_exitcode(status), "output": output.decode(errors="replace").replace("\r\n", "\n")}))
