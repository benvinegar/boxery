"""Draw the README's boxery host diagram, host-light.svg and host-dark.svg, in the hero's isometric style.

The host is trusted and holds the real keys; the VMs are untrusted and hold only a token the host swaps.

    python3 docs/diagrams/host.py   # or python3 docs/diagrams, for every diagram
"""
from pathlib import Path

from parts import THEMES, Diagram

HERE = Path(__file__).parent

TITLE = "The boxery host: trusted, between your agent and the untrusted VMs"
DESC = (
    "Coding agents on your machine (Claude Code, Codex, Cursor, opencode, pi) reach the boxery host over ssh. "
    "The host is trusted: it holds your real LLM keys and API tokens and runs the credential proxy, grants, "
    "leases and the shared pool, and images and forks. It creates, forks and wipes VMs on Lima, libvirt, exe.dev "
    "or boat.dev. The VMs are untrusted: they run any code and hold only a revocable per-VM token, which the host "
    "proxy swaps for your real key."
)

PARTS = [("Credential proxy", "token → real key"), ("Grants", "GitHub · npm · ssh"),
         ("Leases &amp; pool", "exclusive, expiring"), ("Images &amp; forks", "snapshot · fork · reset")]
BACKENDS = [("Lima", "your Mac", ["demo", "web"]), ("libvirt", "Linux machine", ["ci-1", "ci-2"]),
            ("exe.dev", "cloud", ["fix-a", "fix-b"]), ("boat.dev", "cloud", ["try-1", "try-2"])]


class Host(Diagram):
    def token(self, cx, cy, w=40, h=14, size=9):
        t = self.t
        self.pill(cx, cy, w, h, t["warn"], t["warn_line"], 0.75)
        self.text(cx, cy, "token", size, t["warn_text"])

    def draw(self):
        t = self.t
        self.text(44, 34, "Your machine", 13, t["label"], anchor="start")
        self.region(40, 50, 600, 92, t["muted"])
        self.agents(120, 64)
        self.arrow(340, 146, 340, 186)
        self.text(352, 166, "ssh · vm_* tools", 12, t["label"], anchor="start")

        # the host: trusted, with what it runs
        y0 = 190
        self.slab(56, y0, 568, 136, 8, t["bar"])
        lock = t["bar_text"]
        self.add(f'<rect x="72" y="{y0 + 21}" width="13" height="10" rx="2" fill="{lock}"/>')
        self.add(f'<path d="M75 {y0 + 21} V{y0 + 17.5} A3.5 3.5 0 0 1 82 {y0 + 17.5} V{y0 + 21}" fill="none" '
                 f'stroke="{lock}" stroke-width="1.6"/>')
        self.text(94, y0 + 24, "boxery host", 16, t["bar_title"], 600, "start")
        self.pill(577, y0 + 24, 62, 22, t["bar_pill"], "none")
        self.text(577, y0 + 24, "trusted", 11, t["bar_title"], 600)
        self.text(72, y0 + 48, "Holds your real LLM keys and API tokens. They never enter a VM.", 13, t["bar_text"],
                  anchor="start")
        for i, (name, sub) in enumerate(PARTS):
            x, y = 72 + i * 135, y0 + 66
            self.slab(x, y, 125, 48, 4, t["bar_card"])
            self.text(x + 62.5, y + 17, name, 13, t["bar_title"], 600)
            self.text(x + 62.5, y + 34, sub, 11, t["bar_text"])

        # the VMs: untrusted, each holding only a token
        y0 = 386
        self.region(40, 368, 600, 196, t["warn_line"], t["warn"])
        self.text(340, 352, "create · fork · wipe", 11, t["label"])
        for i, (name, sub, vms) in enumerate(BACKENDS):
            x = 56 + i * 146
            cx = x + 65
            self.arrow(cx, 334, cx, y0 - 4)
            self.slab(x, y0, 130, 140, 6, t["host"], "4 3" if sub == "cloud" else None)
            self.text(cx, y0 + 24, name, 14, t["ink"], 600)
            self.text(cx, y0 + 43, sub, 12, t["host_sub"])
            by = y0 + 92
            for vx, vm in zip((cx - 30, cx + 30), vms):
                self.cube(vx, by, 12)
                self.text(vx, by + 14, vm, 12, t["vm_text"])
                self.token(vx, by + 32)
        self.text(60, 546, "VMs · untrusted", 14, t["warn_text"], 600, "start")
        self.text(620, 546, "run any code · hold only a revocable token", 12, t["warn_text"], anchor="end")

        # a VM's token goes to the credential proxy, which swaps it for the real key
        self.arrow(86, y0 - 2, 86, 312, t["warn_line"], "3 3", "arrow-tok")
        self.token(86, 350, 48, 18, 10)


def main():
    for name, theme in THEMES.items():
        h = Host(theme)
        h.draw()
        (HERE / f"host-{name}.svg").write_text(h.svg(680, 580, TITLE, DESC, [("arrow-tok", theme["warn_line"])]))


if __name__ == "__main__":
    main()
