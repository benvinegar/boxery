# /// script
# dependencies = ["fonttools"]
# ///
"""Generate the social-card SVGs in this directory, with all text as outlines.

usage: uv run docs/brand/social-card.py [path/to/JetBrainsMono-Regular.ttf]
then:  for f in docs/brand/{social-preview,og-image,works-with-card}-*.svg; do rsvg-convert "$f" -o "${f%.svg}.png"; done
"""
import re
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

BRAND = Path(__file__).parent
FONT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Library/Fonts/JetBrainsMono-Regular.ttf"
TAGLINE = ["Easiest way to give your coding agents VMs"]
INSTALL = "npm install -g boxery-vm"

THEMES = {
    "dark": dict(bg="#2C2C2A", ink="#F1EFE8", muted="#B4B2A9", dots="#F1EFE8", dots_op=0.07, pill="#383836", pill_line="#4A4A47"),
    "light": dict(bg="#F1EFE8", ink="#2C2C2A", muted="#5F5E5A", dots="#2C2C2A", dots_op=0.08, pill="#E7E4DB", pill_line="#D3D1C7"),
}
SIZES = {"social-preview": (1280, 640), "og-image": (1200, 630)}

font = TTFont(FONT)
upm = font["head"].unitsPerEm
cmap = font.getBestCmap()
glyphs = font.getGlyphSet()
hmtx = font["hmtx"]


def text_width(s, size):
    return sum(hmtx[cmap[ord(c)]][0] for c in s) * size / upm


def text_path(s, size, cx, baseline, fill, tracking=0.0, left=None):
    """One <path> for string s, centered on cx (or starting at `left`), in JetBrains Mono at `size` px."""
    k = size / upm
    names = [cmap[ord(c)] for c in s]
    adv = [hmtx[n][0] + tracking * upm for n in names]
    width = (sum(adv) - tracking * upm) * k
    x = 0.0
    parts = []
    for n, a in zip(names, adv):
        pen = SVGPathPen(glyphs)
        glyphs[n].draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(f'<path transform="translate({x:.1f} 0)" d="{d}"/>')
        x += a
    x0 = cx - width / 2 if left is None else left
    return (
        f'<g fill="{fill}" transform="translate({x0:.2f} {baseline:.2f}) scale({k:.6f} {-k:.6f})">'
        + "".join(parts)
        + "</g>"
    )


def lockup(theme):
    svg = (BRAND / f"lockup-{theme}.svg").read_text()
    inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
    return inner, 241, 64


def backdrop(t, w, h, defs=""):
    """The shared card background: faded dot grid over the theme color, green bar along the bottom."""
    return f"""<defs>
<pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse" x="{(w % 32) / 2}" y="{(h % 32) / 2}"><circle cx="16" cy="16" r="1.6" fill="{t['dots']}"/></pattern>
<radialGradient id="fade" cx="50%" cy="50%" r="75%"><stop offset="0.25" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></radialGradient>
<mask id="edge"><rect width="{w}" height="{h}" fill="url(#fade)"/></mask>{defs}
</defs>
<rect width="{w}" height="{h}" fill="{t['bg']}"/>
<rect width="{w}" height="{h}" fill="url(#dots)" opacity="{t['dots_op'] * 3}" mask="url(#edge)"/>
<rect y="{h - 8}" width="{w}" height="8" fill="#1D9E75"/>
<rect y="{h - 8}" x="{w / 2}" width="{w / 2}" height="8" fill="#0F6E56"/>"""


def card(theme, w, h):
    t = THEMES[theme]
    inner, lw, lh = lockup(theme)
    ls = 500 / lw
    lock_w, lock_h = lw * ls, lh * ls

    tag_size = 34
    tag_lh = tag_size * 1.5
    gap = 44
    cmd_gap, pill_h = 40, 60
    block_h = lock_h + gap + tag_lh * len(TAGLINE) + cmd_gap + pill_h
    top = (h - block_h) / 2
    # Keep the block compact enough that, centered, it clears the bottom 18%, where
    # X/Twitter and others overlay the link domain.
    assert top + block_h <= h * 0.82, "card content runs into the bottom overlay zone"
    lx = w / 2 - 121.8 * ls  # visible lockup spans x 6.6..237 of its 241-wide viewBox
    tag_top = top + lock_h + gap

    tags = "".join(
        text_path(line, tag_size, w / 2, tag_top + tag_size * 0.95 + i * tag_lh, t["muted"])
        for i, line in enumerate(TAGLINE)
    )
    # the install command as a terminal line: green prompt, command in ink, on a pill
    cmd_size = 26
    prompt = "$ "
    cmd_w = text_width(prompt + INSTALL, cmd_size)
    cmd_x = (w - cmd_w) / 2
    pill_w = cmd_w + 56
    pill_y = tag_top + tag_lh * len(TAGLINE) + cmd_gap
    cmd_base = pill_y + pill_h / 2 + cmd_size * 0.36
    install = (
        f'<rect x="{(w - pill_w) / 2:.2f}" y="{pill_y:.2f}" width="{pill_w:.2f}" height="{pill_h}" rx="12" fill="{t["pill"]}" stroke="{t["pill_line"]}" stroke-width="1.5"/>'
        + text_path("$", cmd_size, 0, cmd_base, "#1D9E75", left=cmd_x)
        + text_path(INSTALL, cmd_size, 0, cmd_base, t["ink"], left=cmd_x + text_width(prompt, cmd_size))
    )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="boxery: {' '.join(TAGLINE)}">
{backdrop(t, w, h)}
<g transform="translate({lx:.2f} {top:.2f}) scale({ls:.5f})">{inner}</g>
{tags}
{install}
</svg>
"""


# The "works with" card restacks the README's logo row (docs/works-with-*.svg) one platform
# per line. Each logo is cropped out of that row by its x span, measured from a render of it;
# the shared y window keeps the row's own vertical alignment. Update these if the row changes.
WORKS_WITH_Y = (54, 84)
WORKS_WITH = [
    ("macOS", [(40.0, 90.0)]),  # Lima
    ("Linux", [(171.5, 224.0), (257.8, 415.0), (448.8, 567.2)]),  # libvirt, Cloud Hypervisor, OpenShell
    ("Cloud", [(647.5, 748.2), (780.8, 852.0)]),  # exe.dev, boat
]


def works_with_card(theme, w, h):
    t = THEMES[theme]
    row = (BRAND.parent / f"works-with-{theme}.svg").read_text()
    row_defs = re.search(r"<defs>(.*?)</defs>", row, re.S).group(1)
    # the logo layer is the last top-level group: everything after the divider lines
    logos = row[row.rindex("<g fill=") : row.rindex("</svg>")]

    inner, lw, lh = lockup(theme)
    ls = 300 / lw
    lock_h = lh * ls
    lx = w / 2 - 121.8 * ls

    s = 1.75  # logo scale
    y0, y1 = WORKS_WITH_Y
    logo_h = (y1 - y0) * s
    row_gap, logo_gap = 26, 60
    label_size, label_gap = 26, 34
    cap_size = 24
    label_w = max(text_width(name, label_size) for name, _ in WORKS_WITH)
    rows_w = max(sum(b - a for a, b in spans) * s + logo_gap * (len(spans) - 1) for _, spans in WORKS_WITH)
    block_w = label_w + 2 * label_gap + rows_w
    left = (w - block_w) / 2
    divider_x = left + label_w + label_gap
    logos_x = divider_x + label_gap

    rows_h = logo_h * len(WORKS_WITH) + row_gap * (len(WORKS_WITH) - 1)
    block_h = lock_h + 34 + cap_size + 40 + rows_h
    top = (h - block_h) / 2
    # same bottom-overlay rule as the other cards
    assert top + block_h <= h * 0.82, "card content runs into the bottom overlay zone"

    cap_base = top + lock_h + 34 + cap_size * 0.8
    rows_top = top + lock_h + 34 + cap_size + 40
    parts = [text_path("works with", cap_size, w / 2, cap_base, t["muted"])]
    for i, (name, spans) in enumerate(WORKS_WITH):
        ry = rows_top + i * (logo_h + row_gap)
        parts.append(
            text_path(name, label_size, 0, ry + logo_h / 2 + label_size * 0.36, t["muted"], left=divider_x - label_gap - text_width(name, label_size))
        )
        x = logos_x
        for a, b in spans:
            a, b = a - 1, b + 1  # a pixel of slack so antialiased edges aren't cropped
            # a nested viewport crops the whole logo layer down to this one logo
            parts.append(
                f'<svg x="{x:.2f}" y="{ry:.2f}" width="{(b - a) * s:.2f}" height="{logo_h:.2f}" viewBox="{a} {y0} {b - a:.1f} {y1 - y0}" overflow="hidden"><use href="#logos"/></svg>'
            )
            x += (b - a) * s + logo_gap
    parts.append(
        f'<line x1="{divider_x:.2f}" y1="{rows_top:.2f}" x2="{divider_x:.2f}" y2="{rows_top + rows_h:.2f}" stroke="{t["pill_line"]}" stroke-width="1.5"/>'
    )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="boxery works with Lima on macOS; libvirt, Cloud Hypervisor and OpenShell on Linux; exe.dev and boat in the cloud">
{backdrop(t, w, h, row_defs + logos.replace("<g fill=", '<g id="logos" fill=', 1))}
<g transform="translate({lx:.2f} {top:.2f}) scale({ls:.5f})">{inner}</g>
{"".join(parts)}
</svg>
"""


for name, (w, h) in SIZES.items():
    for theme in THEMES:
        out = BRAND / f"{name}-{theme}.svg"
        out.write_text(card(theme, w, h))
        print(out)

for theme in THEMES:
    out = BRAND / f"works-with-card-{theme}.svg"
    out.write_text(works_with_card(theme, 1200, 630))
    print(out)
