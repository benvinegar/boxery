# boxery visual style

← [Back to the brand assets](README.md)

How boxery looks and sounds, in diagrams, cards and videos. The README hero ([`docs/hero.py`](../hero.py)), the social cards ([`social-card.py`](social-card.py)) and the promo video ([`docs/promo/`](../promo/README.md)) all follow it.

## Principles

- **The cube is a VM.** Everything else in a picture is there to show what happens to the VMs.
- **Show the real thing.** Use real tool names, real CLI output and real timings, taken from the code and docs as they are now. Don't invent features or numbers.
- **One idea at a time.** Each moment of a video, or each part of a diagram, makes one point. Leave anything that needs to be read on screen long enough to read it.
- **Outcomes over features.** Show what someone gets from boxery, not a list of what it can do.

## Colors

The mark's three colors carry the brand. Everything else is a warm grey.

| Role | Dark | Light |
|---|---|---|
| Background | `#2C2C2A` | `#F1EFE8` |
| Ink: text, the cube's left face, outlines | `#F1EFE8` | `#2C2C2A` |
| Cube top, primary accent | `#1D9E75` | `#1D9E75` |
| Cube right face, secondary accent | `#0F6E56` | `#0F6E56` |
| Ghost: dashed outlines, highlights, good results | `#5DCAA5` | `#0F6E56` |
| VM labels | `#9FE1CB` | `#085041` |
| Secondary text | `#B4B2A9` | `#5F5E5A` |
| Muted text, idle bars | `#888780` | `#888780` |
| Leaders, dim strokes | `#5F5E5A` | `#B4B2A9` |
| Bar track, failed marks | `#444441` | `#D3D1C7` |
| Panels: face, side, bottom, stroke | `#1F1F1D` `#181817` `#121211` `#5F5E5A` | `#F1EFE8` `#D3D1C7` `#B4B2A9` `#B4B2A9` |
| The host platform: top, sides, stroke | `#232321` `#1A1A19` `#444441` | `#F7F6F2` `#ECEAE3` `#D3D1C7` |

Social content uses the dark theme. Green is for things that are boxery or that worked. Don't add other accent colors. The hero's purple agent bar is the one exception, and it is only for marking "your agent" in a diagram.

## Type

- **JetBrains Mono** for the wordmark, commands, tool calls, CLI output and in-world labels. On a canvas, use the **JetBrains Mono NL** cut: the regular cut turns `==>` and `->` into ligatures.
- **System sans** (`system-ui, -apple-system, 'Helvetica Neue', Arial`) for headlines and anything said in sentences.
- Headlines are bold with slightly tight tracking (-1px at 62px). Put the important phrase on its own line in ghost green.

Sizes on a 1080×1080 frame:

| Use | Size and weight |
|---|---|
| Title headline | 62 sans bold |
| End card tagline | 50 sans bold |
| Section headline | 40 sans bold |
| Chat text | 27 sans |
| Install command | 34 mono |
| Tool call | 23 mono, tool name bold |
| Labels, tool output | 22 mono 500 |

## The isometric world

Everything is drawn in the mark's projection: an edge along x goes right and down at 30°, an edge along y goes left and down at 30°, and z goes straight up. In code, `C = cos 30°` and `S = 0.5`:

```
screen x = ox + (gx − gy) · C · u
screen y = oy + (gx + gy) · S · u − gz · u
```

Faces are lit as in the mark: green on top, ink on the left and dark green on the right. Stay strictly isometric: no perspective, no rotation, and no shading beyond the three face colors.

### What a cube's state means

| Look | Meaning |
|---|---|
| Solid cube | A running VM |
| Dashed outline in ghost green (dash 7, gap 6) | A VM that is booting or about to be made |
| A tighter dashed copy just behind a cube (3, 4) | A snapshot of that VM |
| A grey line from one cube to others | A fork: the others were copied from it |
| Faded dotted outline (3, 5) with a grey ✕ | A VM that was thrown away |
| A green tile under the cube, a small lift, and a green ✓ | The VM whose result was kept |

### Scenery

- **A host** is a wide, low platform in the host colors that the VMs stand on, named with a callout: its name, then what it is ("your Linux server", "your Mac", a cloud provider).
- **The floor** is a grid of ink lines at 5% opacity, just enough to show the plane.
- **Callouts** are a 4px ghost-green dot on the object, a 1.5px leader in the dim color, and mono 22 text. The first line is the name and the second line is in secondary text.
- **Progress bars** are 10px tall with fully rounded ends, on a `#444441` track. Use green for the one that matters and muted grey for the others.
- **Data moving** (a request, a copy, a push) is a dashed ghost-green line with a moving dash offset and a dot at its head.
- **Secrets** (keys, tokens) are drawn as an ink key sitting on the host, never inside a VM, because that's where boxery keeps them.
- Anything new a story needs (a browser, a file, a service) is drawn from the same parts: iso tiles and boxes in the panel or host colors, outlines in the dim color, and green only where boxery or a good result is.

## Layout

- The background is `#2C2C2A` with a 32px dot grid in ink: 1.6px dots at 20% that fade out toward the centre in the video, and a flat 7% on the static social cards.
- A two-tone bar along the bottom edge, green on the left half and dark green on the right, 10px tall in a 1080 frame.
- Keep 48 to 64px margins and nothing touching the edges. Labels near the right edge are right-aligned.
- During a story the lockup sits in the top-left corner at half size, so the brand is on screen the whole time without competing.
- Panels, such as an agent's chat, are rounded rectangles (20px radius) in the panel face color with a 1.5px stroke. They never cover a cube.

## Motion

| Use | Easing |
|---|---|
| Things arriving | ease-out cubic |
| Things moving from one place to another, the camera | ease-in-out cubic |
| Cubes popping in, ✓ and ✕ | back (overshoot 1.4) |
| The mark's inner cube landing in its outline | bounce: only for the mark |

- Entrances take 0.35 to 0.6 s. Text rises 10 to 16px as it fades in.
- Stagger groups by 0.1 to 0.25 s per item.
- Make one change at a time, about one beat every 2 to 3 seconds. Hold anything people need to read for at least 1.5 s.
- No hard cuts. The lockup is one continuous object from the title to the corner to the end card. Scenes cross-fade, and the old one is gone before the new headline arrives.
- The camera only pulls back or pushes in, slowly, to make room. It never spins.
- Every frame is a pure function of time, so any moment can be rendered again exactly.

## Words

- Write like a person explaining it to a colleague. Prefer short words and concrete nouns.
- Avoid AI-product phrasing: "seamlessly", "supercharge", "unleash", "next-level", "effortless", "empower", "revolutionize", and "not just X, it's Y".
- An agent in a video speaks in short, plain sentences and says what it did and why.
- The tagline is **Easiest way to give your coding agents VMs**. Use it as written, with no full stop.
- The opening line is **Your coding agent deserves its own VMs**.
- The install command is `npx add-mcp boxery-vm`, and the repo is `github.com/modem-dev/boxery`.

## A promo video

Every boxery video has the same opening and close. Only the story in the middle changes.

| Part | Length | What happens |
|---|---|---|
| Opening | about 2.3 s | The mark draws in: the outline traces, then the inner cube drops in and bounces. The opening line comes up under it in two lines, with the second line in ghost green. The lockup then glides to the top-left corner as the wordmark appears. |
| Story | as long as it needs | Any story, told in the isometric world. The lockup stays in the corner throughout. |
| End card | about 3.9 s | The story fades out, and the lockup glides back to the centre. Then the tagline, the install command (in a green-outlined pill with a green `$`), and the repo with "Open source · MIT" underneath. |
| Works with | about 3.8 s | The card's text clears, and the lockup moves up. The agents boxery works with come in one at a time, then "and any MCP client". The repo line stays from the end card. |

The opening and close stay the same unless someone decides to change the brand itself. A different story is told within the same style, not with new colors, type or motion.

## The coding agents boxery works with

Claude Code, Codex, Cursor, opencode and pi, always in that order, shown as monochrome ink logos with their names underneath, followed by "and any MCP client". The logo paths live in `docs/hero.py` (`AGENTS`), and `docs/promo/promo.html` has a copy. Don't recolor them or place them on colored tiles. Keep the agent chat in a video neutral too, so it doesn't copy any one agent's interface.
