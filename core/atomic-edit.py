"""Bounded, advisory snapshot/CAS for vm_edit. Invoked over SSH, JSON on stdin/stdout.

One persistent lock per uid serializes all cooperating edits, including case
aliases (never unlink the lock file). Arbitrary writers can race the final check.
"""
import base64
import fcntl
import hashlib
import json
import os
import secrets
import signal
import stat
import sys

MAX_BYTES = 16 * 1024 * 1024
LOCK_DIRECTORY = f"/tmp/boxery-edit-{os.getuid()}"


def interrupted(signum, _frame):
    raise RuntimeError("edit interrupted (commit outcome may be unknown)")


def version(s):
    # Nanosecond timestamps/inode numbers must survive a JavaScript JSON roundtrip.
    return [str(v) for v in (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns,
                            s.st_ctime_ns, s.st_mode, s.st_uid, s.st_gid, s.st_nlink)]


def resolve(path):
    """Record every traversed link and directory identity (not directory times)."""
    if not os.path.isabs(path):
        raise RuntimeError("edit path must be absolute")
    pending = path.split(os.sep)
    target = os.sep
    chain = []
    links = 0
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            target = os.path.dirname(target)
            continue
        target = os.path.join(target, part)
        s = os.lstat(target)
        if stat.S_ISLNK(s.st_mode):
            links += 1
            if links > 40:
                raise RuntimeError("too many symbolic links")
            link = os.readlink(target)
            chain.append([target, version(s), link])
            target = os.sep if os.path.isabs(link) else os.path.dirname(target)
            pending = link.split(os.sep) + pending
        elif stat.S_ISDIR(s.st_mode):
            chain.append([target, str(s.st_dev), str(s.st_ino)])
        elif pending:
            raise RuntimeError("not a directory")
    return target, chain


def lock_edits():
    # Path spellings (including realpath) need not agree for case aliases.
    # A single per-user lock avoids filesystem-specific alias normalization.
    directory = LOCK_DIRECTORY
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        pass
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        s = os.fstat(dfd)
        if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700:
            raise RuntimeError("unsafe edit lock directory")
        fd = os.open("edit.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=dfd)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != 0o600:
                raise RuntimeError("unsafe edit lock file")
            fcntl.flock(fd, fcntl.LOCK_EX)
            return fd
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(dfd)


def observe(dfd, name):
    # Nonblocking + no-follow rejects FIFOs/devices/late symlinks before reading.
    if not stat.S_ISREG(os.stat(name, dir_fd=dfd, follow_symlinks=False).st_mode):
        raise RuntimeError("not a regular file")
    fd = os.open(name, os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=dfd)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode):
            raise RuntimeError("not a regular file")
        if s.st_nlink != 1:
            raise RuntimeError("cannot atomically edit multiply-linked file")
        if s.st_size > MAX_BYTES:
            raise RuntimeError("edit file exceeds 16 MiB")
        data = bytearray()
        while len(data) <= MAX_BYTES:
            chunk = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise RuntimeError("edit file exceeds 16 MiB")
        if version(s) != version(os.fstat(fd)) or version(s) != version(os.stat(name, dir_fd=dfd, follow_symlinks=False)):
            raise RuntimeError("edit conflict: file changed during observation; reread and retry")
        return s, bytes(data)
    finally:
        os.close(fd)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(request):
    path = request["path"]
    committing = request["op"] == "commit"
    expected = request.get("snapshot")
    lockfd = dfd = None
    temp = None
    try:
        target, chain = resolve(path)
        if committing and (target != expected["target"] or chain != expected["chain"]):
            raise RuntimeError("path or symlink changed")
        lockfd = lock_edits()
        if resolve(path) != (target, chain):
            raise RuntimeError("path changed while waiting for lock")
        parent, name = os.path.split(target)
        # Linux O_PATH (or O_SEARCH elsewhere) needs search, not directory read
        # permission. Platforms without either retain an O_RDONLY fallback.
        access = getattr(os, "O_PATH", getattr(os, "O_SEARCH", os.O_RDONLY))
        dfd = os.open(parent, access | os.O_DIRECTORY | os.O_NOFOLLOW)
        parent_id = os.fstat(dfd)

        def check_path():
            if resolve(path) != (target, chain):
                raise RuntimeError("path or symlink changed")
            s = os.stat(parent)
            if (s.st_dev, s.st_ino) != (parent_id.st_dev, parent_id.st_ino):
                raise RuntimeError("parent directory changed")

        s, original = observe(dfd, name)
        check_path()
        snapshot = {"target": target, "chain": chain, "version": version(s), "sha256": digest(original)}
        if not committing:
            return {"snapshot": snapshot, "data": base64.b64encode(original).decode("ascii")}
        if snapshot != expected:
            raise RuntimeError("file version or content changed")
        updated = base64.b64decode(request["data"], validate=True)
        if len(updated) > MAX_BYTES:
            raise RuntimeError("edit result exceeds 16 MiB")
        temp = ".boxery-edit-" + secrets.token_hex(16)
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        except OSError:
            # Do not remove an entry we did not create (including a name collision).
            temp = None
            raise
        with os.fdopen(fd, "wb") as out:
            out.write(updated)
            out.flush()
            # chown may clear set-id bits, so restore basic mode afterwards.
            current = os.fstat(out.fileno())
            if (current.st_uid, current.st_gid) != (s.st_uid, s.st_gid):
                os.fchown(out.fileno(), s.st_uid, s.st_gid)
            os.fchmod(out.fileno(), stat.S_IMODE(s.st_mode))
            final = os.fstat(out.fileno())
            if (final.st_uid, final.st_gid, stat.S_IMODE(final.st_mode)) != (s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)):
                raise RuntimeError("cannot preserve ownership/mode")
            os.fsync(out.fileno())
        now, data = observe(dfd, name)
        if version(now) != version(s) or data != original:
            raise RuntimeError("file changed while staging")
        check_path()
        os.replace(temp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        temp = None
        return {"committed": True}
    except (OSError, RuntimeError) as e:
        if committing:
            raise RuntimeError(f"edit conflict or commit failure: {e}; reread and retry") from e
        raise
    finally:
        try:
            if temp is not None and dfd is not None:
                try:
                    os.unlink(temp, dir_fd=dfd)
                except FileNotFoundError:
                    # A signal can arrive just after rename but before temp is cleared.
                    pass
        finally:
            if dfd is not None:
                os.close(dfd)
            if lockfd is not None:
                os.close(lockfd)


def main():
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGALRM):
        signal.signal(sig, interrupted)
    signal.alarm(60)
    try:
        raw = sys.stdin.buffer.read(3 * MAX_BYTES + 1)
        if len(raw) > 3 * MAX_BYTES:
            raise RuntimeError("edit request too large")
        result = run(json.loads(raw))
        print(json.dumps(result))
    except Exception as e:
        print(f"vm_edit: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
