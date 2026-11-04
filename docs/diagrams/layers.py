"""Draw layers-light.svg and layers-dark.svg: which program fills each virtualization layer, per backend.

    python3 docs/diagrams/layers.py   # or python3 docs/diagrams, for every diagram
"""
from pathlib import Path

from parts import THEMES, Diagram

HERE = Path(__file__).parent
W = 680

# Backends left to right, each with the one thing it's best at and whether it's experimental (both from
# docs/install.md#choosing-a-backend), and its column width, sized to its longest label.
BACKENDS = [("Lima", "local", False, 88), ("libvirt", "fastest", False, 74),
            ("Cloud Hypervisor", "minimal", True, 108), ("OpenShell", "restricted", True, 80),
            ("exe.dev · boat", "no hardware", True, 84)]
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
    (0, 0, 2, 2, "boxery + systemd", [], "host"),  # boxery's backend is the manager
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
ROW_Y, ROW_H, ROW_GAP = NAME_Y + 64, 34, 10


def col_x():
    xs, x = [], GRID_X
    for _, first, last in PLATFORMS:
        x += PAD
        for i in range(first, last + 1):
            xs.append(x)
            x += BACKENDS[i][-1] + GAP
        x += PAD - GAP + PANEL_GAP
    return xs, x - PANEL_GAP


def row_y(r):
    return ROW_Y + r * (ROW_H + ROW_GAP)


class Layers(Diagram):
    def box(self, x, y, w, h, title, subs, kind, size=12):
        t = self.t
        if kind == "none":
            self.wire(x, y, w, h, 3, t["dash"])
        else:
            self.slab(x, y, w, h, 3, t[{"card": "card", "host": "bar", "vm": "vm"}[kind]])
        ink, sec = {
            "card": (t["ink"], t["label"]),
            "host": (t["bar_title"], t["bar_text"]),
            "vm": (t["vm_text"], t["vm_text"]),
            "none": (t["label"], t["muted"]),
        }[kind]
        cy = y + h / 2 - len(subs) * 7.5
        self.text(x + w / 2, cy, title, size, ink, 600)
        for i, s in enumerate(subs):
            self.text(x + w / 2, cy + 16 + i * 14, s, 11, sec)

    def draw(self):
        t = self.t
        xs, right = col_x()

        # the orchestrator, with an arrow down into each platform
        self.text(LABEL_X, HOST_Y + HOST_H / 2, "Orchestrator", 13, t["ink"], 600, "start")
        self.slab(GRID_X, HOST_Y, right - GRID_X, HOST_H, 6, t["bar"])
        self.text((GRID_X + right) / 2, HOST_Y + 15, "boxery host", 13, t["bar_title"], 600)
        self.text((GRID_X + right) / 2, HOST_Y + 31, "one interface over every backend: new, fork, snapshot, wipe",
                  11, t["bar_text"])
        for name, first, last in PLATFORMS:
            x0 = xs[first] - PAD
            x1 = xs[last] + BACKENDS[last][-1] + PAD
            self.slab(x0, PANEL_Y, x1 - x0, PANEL_H, 6, t["host"])
            self.text(x0 + 12, PANEL_Y + 18, name, 13, t["ink"], 600, "start")
            mx = (x0 + x1) / 2
            self.arrow(mx, HOST_Y + HOST_H + 6, mx, PANEL_Y - 3)
        # each backend's name, a pill for what it's best at, and a dashed one if it's experimental
        vm_face, _, _, vm_line = t["vm"]
        for x, (name, best, experimental, w) in zip(xs, BACKENDS):
            self.text(x + w / 2, NAME_Y, name, 12, t["label"], 600)
            self.pill(x + w / 2, NAME_Y + 21, len(best) * 6.2 + 16, 18, vm_face, vm_line)
            self.text(x + w / 2, NAME_Y + 21, best, 11, t["vm_text"], 500)
            if experimental:
                self.add(f'<rect x="{x + (w - 80) / 2:g}" y="{NAME_Y + 36}" width="80" height="18" rx="9" '
                         f'fill="none" stroke="{t["dash"]}" stroke-dasharray="3 2.5"/>')
                self.text(x + w / 2, NAME_Y + 45, "experimental", 11, t["muted"])
        for r, name in enumerate(LAYERS):
            self.text(LABEL_X, row_y(r) + ROW_H / 2, name, 13, t["ink"], 600, "start")
        for r0, r1, c0, c1, title, subs, kind in CELLS:
            x = xs[c0]
            w = xs[c1] + BACKENDS[c1][-1] - x
            self.box(x, row_y(r0), w, row_y(r1) + ROW_H - row_y(r0), title, subs, kind)


PANEL_H = row_y(len(LAYERS)) - ROW_GAP + 12 - PANEL_Y
TITLE = "What runs a boxery VM, layer by layer"
DESC = (
    "The boxery host is the orchestrator over every backend. On macOS, Lima (local): limactl manages Apple's "
    "Virtualization.framework, on the macOS kernel's hypervisor, on Apple silicon. On Linux: libvirt (fastest) "
    "manages QEMU; Cloud Hypervisor (minimal, experimental) is managed by boxery itself, with a systemd unit per VM; "
    "both run on KVM in the Linux kernel. OpenShell (restricted, experimental) goes through its gateway to a "
    "container that shares the host kernel, with no VM. In the cloud, exe.dev and boat (no hardware, experimental) "
    "are reached through their API, and the rest runs on their servers."
)

def main():
    for name, theme in THEMES.items():
        d = Layers(theme)
        d.draw()
        (HERE / f"layers-{name}.svg").write_text(d.svg(W, PANEL_Y + PANEL_H + 20, TITLE, DESC))


if __name__ == "__main__":
    main()
