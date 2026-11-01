# Shapes (VM sizes)

← [Docs](README.md)

A **shape** is a named VM size: vCPUs, memory and disk. Every new VM gets one. boxery ships three, and each host can change them or add its own.

| Shape | vCPUs | Memory | Disk |
|---|---|---|---|
| `small` | 2 | 4 GiB | 20 GiB |
| `standard` (default) | 4 | 8 GiB | 40 GiB |
| `large` | 8 | 16 GiB | 80 GiB |

## Use them

```bash
boxery shapes                    # what this host offers (* = default)
boxery new demo                  # the default shape
boxery new big --shape large
boxery new odd --shape small --mem 2048   # a shape, then flags override single fields (→ "custom")
boxery fork big try-a try-b      # forks get the source's size…
boxery fork big tiny --shape small        # …unless you pass --shape or size flags
boxery ls                        # SHAPE column
```

Agents see them too. `vm_manage {action:"shapes"}` lists them, and `vm_manage {action:"new", shape:"large"}` (or `fork` with `shape`) picks one, through both the [pi extension](pi-extension.md) and the [MCP server](mcp.md).

## Define your own

Shapes live on the **VM host**, so every laptop and agent using the host sees the same ones. Create `~/.config/boxery/shapes.json` there (or `$BOXERY_CONF/shapes.json`):

```json
{
  "default": "dev",
  "shapes": {
    "dev":   { "cpus": 6, "mem": 12288, "disk": 60 },
    "large": { "mem": 24576 },
    "gpu-ish": { "cpus": 16, "mem": 65536, "disk": 200 }
  }
}
```

- `mem` is in MiB, `disk` in GiB, and all values are whole numbers ≥ 1.
- An entry with a built-in's name overrides only the fields it sets. Above, `large` keeps 8 vCPUs and 80 GiB but gets 24 GiB of memory.
- A new name needs all three fields.
- `default` picks the shape used when `new` gets no `--shape` or size flags. It must name a defined shape.
- Names follow the VM name rules: `[a-z][a-z0-9-]*`, at most 31 characters.

The file is read on every command, so changes apply right away to VMs created after the change. Existing VMs keep their size. If the file is invalid, `new`, `fork` and `shapes` fail with the reason rather than falling back to a guess. Built-ins are in [`host/shapes.json`](../host/shapes.json); don't edit that file, since upgrades replace it.

## Notes

- **Which wins:** the shape (or the default shape), then each `--cpus`/`--mem`/`--disk` flag replaces its own field. A VM made with any size flag is listed as `custom`.
- **Disk only grows.** A VM from an image (`--from`, or a fork) never gets a smaller disk than the image it starts from.
- **Lima** takes memory in whole GiB, so `mem` is rounded down there (use multiples of 1024).
- **Resize.** `boxery resize NAME --cpus/--mem/--disk` changes a VM's size after creation. The VM is then listed as `custom`, and its forks copy the new size.
- **Recorded size.** The host records each VM's size in `~/.config/boxery/vm-shapes/NAME.json`, so `ls` can show it and forks can copy it. VMs created before shapes existed show `-`; their forks copy the size the backend reports (or get the default shape on backends that can't report it).
