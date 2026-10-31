## P0 — Must fix

1. **Host command execution through snapshot names — `controller/agentvm:28–35`, `core/agentvm-core.mjs:manage`.**  
   `h()` joins arguments into an unquoted SSH command. An MCP/pi call with `snapshot: "s; touch /tmp/host-owned #"` executes the injected command **on the host**, outside the VM. Several lifecycle CLI arguments have the same exposure. **Fix:** preserve argument boundaries using shell-safe serialization; validate VM names, snapshot names, and numeric options before transport. Add a regression that passes shell metacharacters through the real controller transport.

2. **Proxy grants unrestricted upstream authority — `proxy/agentvm-proxy.mjs:101–175` (still open).**  
   Any valid VM token authorizes arbitrary upstream paths and methods using host credentials. A guest can `DELETE /ollama/api/delete`, pull models, or list/download OpenAI account files instead of merely performing inference. **Fix:** enforce provider-specific method/path allowlists before injecting credentials, including explicit model restrictions where needed. Test administrative and account endpoints are rejected.

## P1 — Should fix

3. **Token updates lose changes and can resurrect revoked credentials — `host/agentvm-host:49–57`, `cmd_new`.**  
   Atomic rename does not protect the read-modify-write transaction. Concurrent creation and removal can write an old token back after revocation or discard another VM’s token. Concurrent same-name creation can overwrite the winning VM’s credential before the losing creation fails. Failed creation also leaves its token registered. **Fix:** serialize token transactions and per-name lifecycle operations; roll back failed creation using an operation generation. Add concurrent create/remove and injected-failure tests.

4. **Guest-controlled proxy resource exhaustion — `proxy/agentvm-proxy.mjs:168–192` (still open).**  
   Requests have no application duration, body-size, or concurrency limits; response writes ignore backpressure. Disconnecting a client does not abort upstream generation. A guest can accumulate stalled requests, buffering, and paid inference after disconnecting. **Fix:** enforce limits, propagate disconnect cancellation through an `AbortController`, and await response drain or use a backpressure-aware pipeline. Test slow readers and abandoned streams.

5. **Truncation happens after unbounded allocation — `core/agentvm-core.mjs:sshRun`, `bashTool`, `readTool`, `copyTool`.**  
   `vm_bash("yes")` accumulates all output before retaining its last 50 KB; `vm_read("/dev/zero")` can buffer forever without a timeout. A compromised guest can exhaust the laptop/MCP server’s memory. Copies also buffer entire archives. **Fix:** maintain bounded streaming output buffers, limit file/image/archive sizes, and stream transfers. Test oversized and endless output.

6. **Timeout/cancellation does not reliably kill remote jobs — `core/agentvm-core.mjs:111–125`.**  
   Cleanup finds a process by an argv suffix, then assumes its PID equals the job’s PGID. `setsid -w` can leave an older waiting wrapper matching that suffix; an explicit `exec sleep 600` removes the marker from the actual job. Cleanup can therefore kill the wrapper while leaving the workload running. **Fix:** record the actual new PGID through a stable supervisor and kill that group. Test with real `setsid`; `test/mcp.test.mjs` currently replaces it with a stub.

7. **Unhandled stdin errors can crash the agent/server — `core/agentvm-core.mjs:84`, local archive extraction.**  
   Child stdin streams have no error handler. A large `vm_write` to an unwritable destination can outlive an SSH child that exits early, emitting an unhandled `EPIPE`. **Fix:** handle stdin errors and settle the operation once, coordinating stream and child completion. Test a multi-megabyte write to a destination that rejects input immediately.

8. **SSH-agent revocation leaves existing forwarding usable — `controller/agentvm:282–285`.**  
   `ssh -O stop` stops multiplex acceptance; it does not terminate existing sessions or their forwarded-agent channels. After `revoke NAME ssh-agent`, processes in an already-connected VM can continue requesting signatures. **Fix:** terminate the forwarding-bearing connection when revoking, explicitly warning that active sessions will disconnect. Existing tests inspect configuration, not actual revocation.

9. **Concurrent grant application corrupts reconciliation — `controller/agentvm:226–265`, `grant_put`, `grant_del`.**  
   Applies share `env.sh.new`, `links.new`, and `targets.new`. Parallel selection/attach/revoke operations can truncate or move each other’s staging files, delete current targets, or republish stale grants after revocation. Local grant-store updates are also unlocked. **Fix:** serialize per-VM mutations/application, reject stale generations, and publish uniquely staged state atomically. Add overlapping apply/revoke tests.

10. **Stock macOS produces empty VM credential/config files — `host/agentvm-host:103`.**  
    BSD `base64` does not support GNU `-w0`. Its failure occurs inside a substitution passed to successful `printf`, so seed generation can continue with empty contents for pi/opencode configuration and the token file. This breaks Lima provisioning on the advertised platform. **Fix:** use portable `base64 | tr -d '\n'` and explicitly check encoding failures. Test with BSD `base64`, not only GNU tooling.

11. **Copy failures are reported as success — `core/agentvm-core.mjs:278–294`.**  
    Both destination scripts finish with `rm -rf`, masking failed extraction, `cp`, or `mv`. Copying into an unwritable existing directory can return “copied” although nothing arrived. **Fix:** preserve the transfer exit status, fail immediately on transfer errors, and perform cleanup through traps/`finally`. Test permission failures and failed extraction.

12. **Cross-guest impersonation remains possible — `host/backends/libvirt.sh:129`, `controller/agentvm:write_ssh_config` (isolation still open).**  
    Guests share an unfiltered bridge, while SSH host-key verification is disabled. A root guest can ARP-spoof another guest and impersonate its SSH endpoint, receiving subsequently applied grants. Guests also retain broad host/LAN reachability. **Fix:** apply anti-spoofing and guest/host isolation filters, and authenticate per-VM SSH host identities using pinned keys or a host CA. Add cross-guest interception tests.

## P2 — Nice to fix

13. **Read/edit error paths execute shell substitutions — `core/agentvm-core.mjs:204,251`.**  
    Paths are safely quoted for `test`, but interpolated into double-quoted error messages. A missing path containing `$(touch /tmp/pwn)` executes that substitution in the VM—even through a read-only-annotated tool. **Fix:** quote the complete diagnostic with `q()` or use `printf` with safely quoted arguments. Test hostile filenames, not just hostile file contents.

14. **Tailscale allowlist trusts forgeable headers — `mcp/agentvm-mcp.mjs:321–325`.**  
    If the backend listener is directly reachable, a bearer holder excluded by `--allow-user` can supply an allowed `Tailscale-User-Login` header. This bypasses the additional identity restriction, **not** bearer authentication. **Fix:** enforce trusted-proxy-only backend access and reject unsupported exposed-listener configurations using header-based identity.

15. **Throwaway deletion runs twice — `extension/index.ts:228–230,284–285,366–367`.**  
    Removing the current ephemeral VM triggers background removal through `setCurrent(null)`, then starts another awaited removal. Whichever loses can report failure after successful deletion. **Fix:** give explicit removal a single awaited owner. Add extension lifecycle tests; current CI does not exercise this behavior.

---

## Resolution (2026-10-31)

| # | Finding | Status |
|---|---|---|
| 1 | Host command execution via snapshot names (controller → host ssh transport) | **Fixed.** Reproduced live first (`agentvm snap chk 'x; touch /tmp/avm-pwned #'` created the file on the host). Every argument is now `%q`-quoted for the remote shell; snapshot names and numeric flags are validated in core, controller and host. Regression tests: `test/shell/controller-local.sh`, `test/shell/host-dispatcher.sh`, `test/mcp.test.mjs` |
| 2 | Proxy grants unrestricted upstream authority | **Fixed.** Per-route method+path allowlist (inference + model listing only), checked before credentials are attached. Ollama admin, OpenAI files/fine-tuning, ChatGPT account endpoints → 403. Tested |
| 3 | Token read-modify-write races; failed creation leaves a token | **Fixed.** `tokens.json` edits serialized with an atomic mkdir lock; `new` revokes its token and removes the half-created VM on any failure (EXIT trap). Tested with 8 parallel creates/removes and an injected backend failure |
| 4 | Proxy resource exhaustion | **Fixed.** Body-size limit (413), per-VM concurrency limit (429), wall-time limit, upstream aborted on client disconnect, `pipeline()` for backpressure |
| 5 | Unbounded buffering in core | **Fixed.** `sshRun` caps captured output (64 MiB default, 16 MiB for reads, 60s read timeout); `vm_bash` keeps a bounded tail while streaming; `vm_read` refuses non-regular files. Tested with 30 MB of output |
| 6 | Timeout/cancel didn't reliably kill remote jobs | **Fixed.** The setsid'd wrapper records its PGID to a file; cleanup kills exactly that group. Tested: a backgrounded `sleep 300` dies on timeout |
| 7 | stdin EPIPE could crash the process | **Fixed** (stdin error handlers) |
| 8 | ssh-agent revocation left open forwards usable | **Fixed.** Grant changes use `ssh -O exit` (tears down existing sessions), not `-O stop` |
| 9 | Concurrent grant application could corrupt state | **Fixed.** Local grant-store edits take a per-VM lock; the in-guest apply takes a flock. Tested with 6 parallel grants/revokes |
| 10 | BSD base64 `-w0` → empty seed payloads on macOS | **Fixed** (`base64 \| tr -d '\n'`). Tested that payloads are non-empty |
| 11 | Copy failures reported as success | **Fixed** (`set -e` + `trap` cleanup on both sides). Tested with an unwritable destination |
| 12 | Cross-guest impersonation / network isolation | **Open** (ARCHITECTURE roadmap step 0: dedicated network + nwfilter, pinned host keys) |
| 13 | Shell substitution in read/edit error messages | **Fixed** (`printf %s` with quoted args). Tested with `$(touch …)` file names |
| 14 | `--allow-user` trusts a forgeable header if exposed | **Fixed.** Refuses to start with `--allow-user` unless bound to loopback (behind `tailscale serve`). Tested |
| 15 | Ephemeral VM deleted twice | **Fixed** (single owner) |
