"""Draw the README hero diagram, hero-light.svg and hero-dark.svg, in the boxery mark's isometric style.

VMs are the mark's solid cube; the cube's state shows what boxery did to it:
solid is running, a dashed copy behind it is a snapshot, a branch is a fork,
and a faded dotted outline is a VM that was thrown away.

    python3 docs/hero.py
"""
import math
from pathlib import Path

HERE = Path(__file__).parent
C, S = math.cos(math.pi / 6), 0.5  # isometric unit vectors, as in the mark
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

THEMES = {
    "light": dict(
        ink="#2C2C2A", muted="#888780", label="#5F5E5A",
        agent=("#F1EFE8", "#D3D1C7", "#B4B2A9", "#B4B2A9"),  # face, side, bottom, stroke
        bar=("#EEEDFE", "#AFA9EC", "#534AB7", "#AFA9EC"),
        bar_title="#26215C", bar_text="#534AB7",
        host=("#F7F6F2", "#ECEAE3", "#D3D1C7", "#D3D1C7"),
        host_sub="#5F5E5A",
        cube=("#1D9E75", "#2C2C2A", "#0F6E56"),  # top, left, right
        ghost="#0F6E56", vm_text="#085041",
    ),
    "dark": dict(
        ink="#F1EFE8", muted="#888780", label="#B4B2A9",
        agent=("#2C2C2A", "#1F1F1D", "#161615", "#5F5E5A"),
        bar=("#26215C", "#1B1745", "#120F33", "#534AB7"),
        bar_title="#EEEDFE", bar_text="#CECBF6",
        host=("#1C1C1B", "#151514", "#0E0E0D", "#444441"),
        host_sub="#B4B2A9",
        cube=("#1D9E75", "#F1EFE8", "#0F6E56"),
        ghost="#5DCAA5", vm_text="#9FE1CB",
    ),
}

AGENTS = [
    ('Claude Code', 56.0, 144.2, '0 0 24 24',
     '<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>'),
    ('Codex', 208.2, 99.0, '0 0 24 24',
     '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>'),
    ('Cursor', 315.2, 102.0, '88 66 336 380',
     '<path fill-rule="evenodd" d="m415.348 156.575-151.504-87.4699c-4.865-2.8094-10.868-2.8094-15.733 0l-151.4964 87.4699c-4.0897 2.361-6.6146 6.728-6.6146 11.458v176.383c0 4.73 2.5249 9.097 6.6146 11.459l151.5034 87.469c4.865 2.81 10.868 2.81 15.733 0l151.504-87.469c4.09-2.362 6.615-6.729 6.615-11.459v-176.383c0-4.73-2.525-9.097-6.615-11.458zm-9.517 18.528-146.254 253.319c-.989 1.707-3.599 1.01-3.599-.967v-165.871c0-3.314-1.771-6.38-4.645-8.044l-143.644-82.932c-1.707-.989-1.01-3.599.967-3.599h292.51c4.153 0 6.749 4.502 4.672 8.101h-.007z"/>'),
    ('opencode', 425.2, 123.9, '0 6 24 30',
     '<path d="M18 30H6V18H18V30Z" opacity="0.35"/><path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z"/>'),
    ('pi', 557.1, 66.9, '165 165 470 470',
     '<path d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/><path d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/><path d="M517.36 400H634.72V634.72H517.36Z"/>'),
]

TITLE = "boxery: self-serve VMs for any coding agent, on any host"
DESC = (
    "Coding agents on your machine (Claude Code, Codex, Cursor, opencode, pi) use boxery to spin up, fork, "
    "snapshot and throw away VMs and to run shells, code, Chrome and the full desktop inside them. "
    "The VMs can run locally on the same machine, on a remote box, or in the cloud on exe.dev, boat.dev "
    "and other providers. VMs are drawn as cubes: on the remote box, ci-2 and ci-3 are forks of ci-1; "
    "in the cloud, fix-a is running, fix-b has a snapshot and fix-c has been thrown away."
)


def pts(*p):
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in p)


class Hero:
    def __init__(self, t):
        self.t = t
        self.o = []

    # ---- primitives ----
    def add(self, s):
        self.o.append(s)

    def poly(self, p, fill, stroke=None, dash=None, sw=1):
        a = f' stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round"' if stroke else ""
        if dash:
            a += f' stroke-dasharray="{dash}"'
        self.add(f'<polygon points="{pts(*p)}" fill="{fill}"{a}/>')

    def text(self, x, y, s, size, fill, weight=None, anchor=None, opacity=None):
        a = f' font-weight="{weight}"' if weight else ""
        a += f' text-anchor="{anchor}"' if anchor else ""
        a += f' opacity="{opacity}"' if opacity else ""
        self.add(f'<text x="{x:g}" y="{y:g}" font-size="{size}"{a} fill="{fill}">{s}</text>')

    def arrow(self, x1, y1, x2, y2):
        self.add(f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{self.t["muted"]}" '
                 f'stroke-width="1.25" marker-end="url(#arrow)"/>')

    def curve(self, d):
        self.add(f'<path d="{d}" fill="none" stroke="{self.t["muted"]}" stroke-width="1.25" '
                 f'stroke-linecap="round" marker-end="url(#arrow)"/>')

    def slab(self, x, y, w, h, d, colors, dash=None):
        """A card extruded down-right at the mark's 30°."""
        face, side, bottom, stroke = colors
        dx, dy = d * C, d * S
        self.poly([(x + w, y), (x + w + dx, y + dy), (x + w + dx, y + h + dy), (x + w, y + h)], side, stroke, dash)
        self.poly([(x, y + h), (x + w, y + h), (x + w + dx, y + h + dy), (x + dx, y + h + dy)], bottom, stroke, dash)
        self.add(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" fill="{face}" stroke="{stroke}"'
                 + (f' stroke-dasharray="{dash}"' if dash else "") + "/>")

    @staticmethod
    def faces(bx, by, e):
        tf, tl, tr = (bx, by - e), (bx - C * e, by - S * e - e), (bx + C * e, by - S * e - e)
        bl, br, tb = (bx - C * e, by - S * e), (bx + C * e, by - S * e), (bx, by - 2 * e)
        return [tf, tr, tb, tl], [(bx, by), bl, tl, tf], [(bx, by), br, tr, tf]

    # ---- cube states (each from the cube's bottom-front vertex) ----
    def cube(self, bx, by, e):
        top, left, right = self.t["cube"]
        for f, c in zip(self.faces(bx, by, e), (top, left, right)):
            self.poly(f, c)

    def outline(self, bx, by, e, dash, opacity=1):
        top, left, right = self.faces(bx, by, e)
        hexagon = [left[0], left[1], left[2], top[2], right[2], right[1]]
        inner = f"M{bx:.2f} {by:.2f} V{by - e:.2f} L{top[3][0]:.2f} {top[3][1]:.2f} M{bx:.2f} {by - e:.2f} L{top[1][0]:.2f} {top[1][1]:.2f}"
        g = self.t["ghost"]
        self.add(f'<g fill="none" stroke="{g}" stroke-width="1.25" stroke-linejoin="round" stroke-dasharray="{dash}"'
                 + (f' opacity="{opacity}"' if opacity != 1 else "") + ">"
                 f'<polygon points="{pts(*hexagon)}"/><path d="{inner}"/></g>')

    def snapshot(self, bx, by, e):
        k = e * 0.45
        self.outline(bx + C * k, by - S * k - k * 0.4, e, "3 2.5")
        self.cube(bx, by, e)

    def gone(self, bx, by, e):
        self.outline(bx, by, e, "1.5 2.5", 0.55)

    # ---- the diagram ----
    def draw(self):
        t = self.t
        self.text(44, 34, "Your machine", 13, t["label"], anchor="start")
        self.add(f'<path d="M56 50 H624 A16 16 0 0 1 640 66 V298 A16 16 0 0 1 624 314 H258 A16 16 0 0 0 242 330 '
                 f'V476 A16 16 0 0 1 226 492 H56 A16 16 0 0 1 40 476 V66 A16 16 0 0 1 56 50 Z" fill="none" '
                 f'stroke="{t["muted"]}" stroke-width="1" stroke-dasharray="5 4"/>')

        # the agents: one card, their icons side by side
        x0, y0 = 120, 64
        self.slab(x0, y0, 440, 60, 6, t["agent"])
        for i, (name, _, _, vb, icon) in enumerate(AGENTS):
            self.add(f'<svg x="{x0 + 20 + i * 27:g}" y="{y0 + 21:g}" width="18" height="18" viewBox="{vb}" fill="{t["ink"]}">{icon}</svg>')
        self.text(x0 + 168, y0 + 21, "Your coding agents", 14, t["ink"], 600, "start")
        self.text(x0 + 168, y0 + 40, " · ".join(a[0] for a in AGENTS), 12, t["label"], anchor="start")
        self.arrow(340, 132, 340, 170)

        # boxery: its four verbs, each drawn as what it does to a cube
        y0 = 174
        self.slab(56, y0, 568, 120, 8, t["bar"])
        self.text(340, y0 + 24, "boxery", 16, t["bar_title"], 600)
        self.text(340, y0 + 44, "Run shells, code, Chrome and the full desktop inside VMs", 13, t["bar_text"])
        e, by = 11, y0 + 88
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
            self.text(cx, by + 20, verb, 12, t["bar_text"], 600)

        hosts = [
            ("Local", "VMs on this machine", 56, 170, ["demo", "web"]),
            ("Remote box", "any server you ssh to", 258, 176, ["ci-1", "ci-2", "ci-3"]),
            ("Cloud", "exe.dev · boat.dev · more", 450, 174, ["fix-a", "fix-b", "fix-c"]),
        ]
        y0, e = 350, 14
        for name, sub, x, w, vms in hosts:
            cx = x + w / 2
            cloud = name == "Cloud"
            self.arrow(cx, 302, cx, y0 - 4)
            self.slab(x, y0, w, 124, 6, t["host"], "4 3" if cloud else None)
            self.text(cx, y0 + 22, name, 14, t["ink"], 600)
            self.text(cx, y0 + 41, sub, 12, t["host_sub"])
            step = 60 if len(vms) == 2 else 50
            by = y0 + 99
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
                self.text(vx, by + 14, vm, 12, t["vm_text"], opacity=0.55 if vm == "fix-c" else None)

    def svg(self):
        self.draw()
        m = self.t["muted"]
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 512" width="680" height="512" role="img" aria-labelledby="t d">\n'
            f'<title id="t">{TITLE}</title>\n<desc id="d">{DESC}</desc>\n'
            '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
            f'<path d="M2 1L8 5L2 9" fill="none" stroke="{m}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>\n'
            f'<g font-family="{FONT}" text-anchor="middle" dominant-baseline="central">\n'
            + "\n".join(self.o)
            + "\n</g></svg>\n"
        )


if __name__ == "__main__":
    for name, theme in THEMES.items():
        (HERE / f"hero-{name}.svg").write_text(Hero(theme).svg())
