# File transfers with `vm_copy`

← [Docs](README.md)

`vm_copy` transfers a file or directory **when explicitly called**. It does not continuously synchronize workspaces, and ordinary shell/file/browser tools do not copy the project back and forth. VM forks use a separate disk-image mechanism.

## Locations

- `local:/path`: the machine running the tools/MCP server, not necessarily your laptop.
- `VM:/path`: a VM on the selected host.
- `HOST/VM:/path`: an explicit named host and VM.
- A bare path: the current VM.

VM-relative paths are under `/home/agent/project`; `~` is `/home/agent`. Local-relative paths use the tool's local working directory. See [named hosts](hosts.md#copy-locations-and-local) for routing.

```json
{"from":"local:./my-repo","to":"demo:project-copy"}
{"from":"alpha/demo:build.zip","to":"beta/worker:build.zip"}
{"from":"demo:screenshot.png","to":"local:./screenshot.png"}
```

If the destination is an existing directory, the source is placed inside it under its original basename, merging existing contents. Otherwise the destination is the new name of the file/directory. Unrelated destination entries and existing directory permissions are preserved. Symlinks and file modes are carried by tar/cp; local macOS uploads omit AppleDouble metadata.

## Streaming and publication

Archives stream through the machine running the tools, including VM-to-VM transfers. This is not a direct host-to-host connection:

```text
source tar → SSH/pipe → bounded agent stream → SSH/pipe → destination staging
```

Backpressure prevents a fast source from filling agent memory while the destination is slow. `vm_copy` no longer buffers a complete archive or applies the old 64 MiB VM-output / 1 GiB local-archive capture limits. Other tools' output limits are unchanged.

The destination extracts into a private staging directory next to the target. No complete archive file is stored. After the stream finishes, **both producer and extractor must exit successfully** before staged contents are published. A valid tar followed by a producer error is still a failed copy and is not committed. Temporary directories created inside a source tree are excluded from its archive to avoid recursive self-copying.

Staging requires disk space for the extracted contents. Publishing a new path can use a same-filesystem rename; merging into an existing directory uses `cp -a` and is **not transactional**. Failure or cancellation after publication begins may leave a partially updated existing directory; there is no rollback of destination changes already made.

## Cancellation and failure

Cancellation or endpoint failure stops the local process groups and fences the VM-side tar/commit groups before removing staging directories. Cleanup uses the same resolved SSH profiles as the original call, even if host selection or registry pointers change during the transfer.

Preparation and cleanup SSH calls have bounded timeouts and may briefly delay cancellation. An unreachable VM can prevent verified cleanup; the tool reports **Cleanup incomplete** rather than silently claiming success. In that case private `.boxery-copy-*` directories may remain beside the destination (or under the source VM's `/tmp`), and data may already have been published. Inspect the error before retrying.

Paths are shell-quoted, and archive input names are NUL-delimited for GNU/BSD tar compatibility, including leading dashes, quotes, backslashes and newlines. Copying the filesystem root itself is rejected.
