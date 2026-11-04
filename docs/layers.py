"""Generate docs/layers-{light,dark}.svg: which program fills each virtualization layer, per backend.

usage: python3 docs/layers.py
"""
from pathlib import Path

DOCS = Path(__file__).parent
W = 680
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

THEMES = {
    "light": dict(ink="#2C2C2A", sec="#5F5E5A", muted="#888780", card="#FFFFFF", line="#D3D1C7", dash="#B4B2A9",
                  panel="#F7F6F2", host="#EEEDFE", host_line="#AFA9EC", host_ink="#26215C", host_sec="#534AB7",
                  vm="#E1F5EE", vm_line="#5DCAA5", vm_ink="#085041"),
    "dark": dict(ink="#F1EFE8", sec="#B4B2A9", muted="#888780", card="#1C1C1B", line="#444441", dash="#5F5E5A",
                 panel="#232321", host="#26215C", host_line="#534AB7", host_ink="#EEEDFE", host_sec="#CECBF6",
                 vm="#04342C", vm_line="#0F6E56", vm_ink="#9FE1CB"),
}

# Backends left to right, each with the one thing it's best at (from docs/install.md#choosing-a-backend),
# and its column width, sized to its longest label.
BACKENDS = [("Lima", "local", 88), ("libvirt", "fastest", 74), ("Cloud Hypervisor", "minimal", 108),
            ("OpenShell", "restricted", 80), ("exe.dev · boat", "no hardware", 84)]
# Each platform is a panel around its backends' columns: (name, first column, last column)
PLATFORMS = [("macOS", 0, 0), ("Linux", 1, 3), ("Cloud", 4, 4)]
LAYERS = ["Manager", "VMM", "Hypervisor", "Hardware"]

# (first layer, last layer, first column, last column, title, subtitle lines, kind). Subtitles only fit
# in cells that span several layers.
CELLS = [
    (0, 0, 0, 0, "limactl", [], "card"),
    (1, 1, 0, 0, "Apple VZ", [], "card"),
    (2, 2, 0, 0, "macOS kernel", [], "vm"),
    (3, 3, 0, 0, "Apple silicon", [], "card"),
    (0, 0, 1, 1, "libvirtd", [], "card"),
    (1, 1, 1, 1, "QEMU", [], "card"),
    (0, 0, 2, 2, "none", [], "none"),
    (1, 1, 2, 2, "cloud-hypervisor", [], "card"),
    (2, 2, 1, 2, "KVM", [], "vm"),
    (0, 0, 3, 3, "gateway", [], "card"),
    (1, 2, 3, 3, "container", ["no VM: shares", "the host kernel"], "none"),
    (3, 3, 1, 3, "Linux machine", [], "card"),
    (0, 0, 4, 4, "API", [], "card"),
    (1, 3, 4, 4, "hidden", ["on their", "servers"], "none"),
]

LABEL_X, GRID_X = 40, 126
PAD, GAP, PANEL_GAP = 7, 8, 12  # inside a panel, between columns, between panels
HOST_Y, HOST_H = 20, 44
PANEL_Y = HOST_Y + HOST_H + 26
NAME_Y = PANEL_Y + 44
ROW_Y, ROW_H, ROW_GAP = NAME_Y + 40, 34, 10


def col_x():
    xs, x = [], GRID_X
    for _, first, last in PLATFORMS:
        x += PAD
        for i in range(first, last + 1):
            xs.append(x)
            x += BACKENDS[i][2] + GAP
        x += PAD - GAP + PANEL_GAP
    return xs, x - PANEL_GAP


def row_y(r):
    return ROW_Y + r * (ROW_H + ROW_GAP)


def svg(theme):
    t = THEMES[theme]
    xs, right = col_x()
    out = []

    def text(x, y, s, size=12, weight=400, fill=t["ink"], anchor="middle"):
        out.append(f'<text x="{x:g}" y="{y:g}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{s}</text>')

    def rect(x, y, w, h, rx, fill, stroke, dashed=False):
        dash = ' stroke-dasharray="5 4"' if dashed else ""
        out.append(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx}" fill="{fill}" stroke="{stroke}"{dash}/>')

    def box(x, y, w, h, title, subs, kind, size=12):
        fill, stroke, ink, sec = {
            "card": (t["card"], t["line"], t["ink"], t["sec"]),
            "host": (t["host"], t["host_line"], t["host_ink"], t["host_sec"]),
            "vm": (t["vm"], t["vm_line"], t["vm_ink"], t["vm_ink"]),
            "none": ("none", t["dash"], t["sec"], t["muted"]),
        }[kind]
        rect(x, y, w, h, 7, fill, stroke, kind == "none")
        cy = y + h / 2 - len(subs) * 7.5
        text(x + w / 2, cy, title, size, 600, ink)
        for i, s in enumerate(subs):
            text(x + w / 2, cy + 16 + i * 14, s, 11, fill=sec)

    # the orchestrator, with an arrow down into each platform
    text(LABEL_X, HOST_Y + HOST_H / 2, "Orchestrator", 13, 600, anchor="start")
    box(GRID_X, HOST_Y, right - GRID_X, HOST_H, "boxery host",
        ["one interface over every backend: new, fork, snapshot, wipe"], "host", 13)
    panel_h = row_y(len(LAYERS)) - ROW_GAP + 12 - PANEL_Y
    for name, first, last in PLATFORMS:
        x0 = xs[first] - PAD
        x1 = xs[last] + BACKENDS[last][2] + PAD
        rect(x0, PANEL_Y, x1 - x0, panel_h, 14, t["panel"], t["line"])
        text(x0 + 12, PANEL_Y + 18, name, 13, 600, anchor="start")
        mx = (x0 + x1) / 2
        out.append(f'<line x1="{mx:g}" y1="{HOST_Y + HOST_H + 2}" x2="{mx:g}" y2="{PANEL_Y - 2}" stroke="{t["muted"]}" stroke-width="1.25" marker-end="url(#arrow)"/>')
    # each backend's name, and a pill for what it's best at
    for x, (name, best, w) in zip(xs, BACKENDS):
        text(x + w / 2, NAME_Y, name, 12, 600, t["sec"])
        pw = len(best) * 6.2 + 16
        rect(x + (w - pw) / 2, NAME_Y + 12, pw, 18, 9, t["vm"], t["vm_line"])
        text(x + w / 2, NAME_Y + 21, best, 11, 500, t["vm_ink"])
    for r, name in enumerate(LAYERS):
        text(LABEL_X, row_y(r) + ROW_H / 2, name, 13, 600, anchor="start")
    for r0, r1, c0, c1, title, subs, kind in CELLS:
        x = xs[c0]
        w = xs[c1] + BACKENDS[c1][2] - x
        box(x, row_y(r0), w, row_y(r1) + ROW_H - row_y(r0), title, subs, kind)

    height = PANEL_Y + panel_h + 20
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {height}" width="{W}" height="{height}" role="img" aria-labelledby="t d">
<title id="t">What runs a boxery VM, layer by layer</title>
<desc id="d">The boxery host is the orchestrator over every backend. On macOS, Lima (local): limactl manages Apple's Virtualization.framework, on the macOS kernel's hypervisor, on Apple silicon. On Linux: libvirt (fastest) manages QEMU; Cloud Hypervisor (minimal) has no manager, so boxery runs it directly; both run on KVM in the Linux kernel. OpenShell (restricted) goes through its gateway to a container that shares the host kernel, with no VM. In the cloud, exe.dev and boat (no hardware) are reached through their API, and the rest runs on their servers.</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="{t["muted"]}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
<g font-family="{FONT}" text-anchor="middle" dominant-baseline="central">
{chr(10).join(out)}
</g>
</svg>
"""


for theme in THEMES:
    p = DOCS / f"layers-{theme}.svg"
    p.write_text(svg(theme))
    print(p)
