# /// script
# dependencies = ["fonttools"]
# ///
"""Generate the social-card SVGs in this directory, with all text as outlines.

usage: uv run docs/brand/social-card.py [path/to/JetBrainsMono-Regular.ttf]
then:  for f in docs/brand/{social-preview,og-image}-*.svg; do rsvg-convert "$f" -o "${f%.svg}.png"; done
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
<defs>
<pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse" x="{(w % 32) / 2}" y="{(h % 32) / 2}"><circle cx="16" cy="16" r="1.6" fill="{t['dots']}"/></pattern>
<radialGradient id="fade" cx="50%" cy="50%" r="75%"><stop offset="0.25" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></radialGradient>
<mask id="edge"><rect width="{w}" height="{h}" fill="url(#fade)"/></mask>
</defs>
<rect width="{w}" height="{h}" fill="{t['bg']}"/>
<rect width="{w}" height="{h}" fill="url(#dots)" opacity="{t['dots_op'] * 3}" mask="url(#edge)"/>
<rect y="{h - 8}" width="{w}" height="8" fill="#1D9E75"/>
<rect y="{h - 8}" x="{w / 2}" width="{w / 2}" height="8" fill="#0F6E56"/>
<g transform="translate({lx:.2f} {top:.2f}) scale({ls:.5f})">{inner}</g>
{tags}
{install}
</svg>
"""


for name, (w, h) in SIZES.items():
    for theme in THEMES:
        out = BRAND / f"{name}-{theme}.svg"
        out.write_text(card(theme, w, h))
        print(out)
