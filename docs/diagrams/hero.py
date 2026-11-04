"""Draw the README hero diagram, hero-light.svg and hero-dark.svg, in the boxery mark's isometric style.

VMs are the mark's solid cube; the cube's state shows what boxery did to it:
solid is running, a dashed copy behind it is a snapshot, a branch is a fork,
and a faded dotted outline is a VM that was thrown away.

    python3 docs/diagrams/hero.py   # or python3 docs/diagrams, for every diagram
"""
from pathlib import Path

from parts import THEMES, Diagram

HERE = Path(__file__).parent

TITLE = "boxery: self-serve VMs for any coding agent, on any host"
DESC = (
    "Coding agents on your machine (Claude Code, Codex, Cursor, opencode, pi) use boxery to spin up, fork, "
    "snapshot and throw away VMs and to run shells, code, Chrome and the full desktop inside them. "
    "The VMs can run locally on the same machine, on a remote box, or in the cloud on exe.dev, boat.dev "
    "and other providers. VMs are drawn as cubes: on the remote box, ci-2 and ci-3 are forks of ci-1; "
    "in the cloud, fix-a is running, fix-b has a snapshot and fix-c has been thrown away."
)


class Hero(Diagram):
    def draw(self):
        t = self.t
        self.text(44, 34, "Your machine", 13, t["label"], anchor="start")
        self.add(f'<path d="M56 50 H624 A16 16 0 0 1 640 66 V322 A16 16 0 0 1 624 338 H258 A16 16 0 0 0 242 354 '
                 f'V522 A16 16 0 0 1 226 538 H56 A16 16 0 0 1 40 522 V66 A16 16 0 0 1 56 50 Z" fill="none" '
                 f'stroke="{t["muted"]}" stroke-width="1" stroke-dasharray="5 4"/>')

        self.agents(120, 64)
        self.arrow(340, 132, 340, 170)

        # boxery: its four verbs, each drawn as what it does to a cube
        y0 = 174
        self.slab(56, y0, 568, 144, 8, t["bar"])
        self.text(340, y0 + 28, "boxery", 16, t["bar_title"], 600)
        self.text(340, y0 + 48, "Run shells, code, Chrome and the full desktop inside VMs", 13, t["bar_text"])
        e, by = 11, y0 + 104
        for i, verb in enumerate(["spin up", "fork", "snapshot", "throw away"]):
            cx = 56 + 568 * (i + 0.5) / 4
            if verb == "spin up":
                self.outline(cx - 22, by, e, "3 2.5")
                self.arrow(cx - 8, by - 11, cx + 6, by - 11)
                self.cube(cx + 22, by, e)
            elif verb == "fork":
                self.cube(cx - 22, by, e)
                self.curve(f"M{cx - 8} {by - 11} C{cx + 2} {by - 11} {cx + 2} {by - 20} {cx + 10} {by - 20}")
                self.curve(f"M{cx - 8} {by - 11} C{cx + 2} {by - 11} {cx + 2} {by - 2} {cx + 10} {by - 2}")
                self.cube(cx + 24, by - 13, 8)
                self.cube(cx + 24, by + 5, 8)
            elif verb == "snapshot":
                self.snapshot(cx - 5, by + 1, 13)
            else:
                self.cube(cx - 22, by, e)
                self.arrow(cx - 8, by - 11, cx + 6, by - 11)
                self.gone(cx + 22, by, e)
            self.text(cx, by + 22, verb, 12, t["bar_text"], 600)

        hosts = [
            ("Local", "VMs on this machine", 56, 170, ["demo", "web"]),
            ("Remote box", "any server you ssh to", 258, 176, ["ci-1", "ci-2", "ci-3"]),
            ("Cloud", "exe.dev · boat.dev · more", 450, 174, ["fix-a", "fix-b", "fix-c"]),
        ]
        y0, e = 374, 14
        for name, sub, x, w, vms in hosts:
            cx = x + w / 2
            cloud = name == "Cloud"
            self.arrow(cx, 326, cx, y0 - 4)
            self.slab(x, y0, w, 148, 6, t["host"], "4 3" if cloud else None)
            self.text(cx, y0 + 26, name, 14, t["ink"], 600)
            self.text(cx, y0 + 46, sub, 12, t["host_sub"])
            step = 60 if len(vms) == 2 else 50
            by = y0 + 116
            xs = [cx + (i - (len(vms) - 1) / 2) * step for i in range(len(vms))]
            if name == "Remote box":  # ci-2 and ci-3 are forks of ci-1
                for i, lift in ((1, 6), (2, 12)):
                    self.curve(f"M{xs[0] + 5} {by - 2 * e - 3} C{xs[0] + 14} {by - 2 * e - 3 - lift} "
                               f"{xs[i] - 14} {by - 2 * e - 3 - lift} {xs[i] - 4} {by - 2 * e - 5}")
            for i, (vx, vm) in enumerate(zip(xs, vms)):
                if vm == "fix-b":
                    self.snapshot(vx, by, e)
                elif vm == "fix-c":
                    self.gone(vx, by, e)
                else:
                    self.cube(vx, by, e)
                self.text(vx, by + 16, vm, 12, t["vm_text"], opacity=0.55 if vm == "fix-c" else None)


def main():
    for name, theme in THEMES.items():
        h = Hero(theme)
        h.draw()
        (HERE / f"hero-{name}.svg").write_text(h.svg(680, 556, TITLE, DESC))


if __name__ == "__main__":
    main()
