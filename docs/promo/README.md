# boxery promo video

← [Back to the docs](../README.md)

A 30 s, 1080×1080 social video of a coding agent using boxery, drawn in the [boxery visual style](../brand/style.md). The video is code. The rendered mp4 isn't committed, so you build it from this folder.

| File | What it is |
|---|---|
| `promo.html` | The whole video: one canvas, drawn by `renderFrame(t)` for any time `t` in seconds. |
| `render.mjs` | Steps `renderFrame` in headless Chrome at 30 fps and pipes the frames to ffmpeg. It can also write review stills. |

## Watch it

Open `promo.html` in Chrome. It loops. Add `?t=12.5` to the URL to freeze on a moment, and press space to pause or resume.

## Render it

You need Google Chrome, ffmpeg and playwright-core:

```sh
npm install --no-save playwright-core
node docs/promo/render.mjs                                  # writes docs/promo/boxery-promo.mp4
node docs/promo/render.mjs --stills 3,8,13,18,24,28 /tmp/s  # PNGs at those times
```

To check the whole video at once, make a contact sheet with one frame every 2 s:

```sh
ffmpeg -i docs/promo/boxery-promo.mp4 -vf "fps=0.5,scale=360:-1,tile=5x3" -frames:v 1 sheet.png
```

## How promo.html is laid out

The header comment lists the timeline. Below it, the sections are:

- **Timing:** `seg`, `out`, `inout`, `back` and `bounce` turn a time into 0..1 progress.
- **Primitives:** `text`, `rrect` and `poly`, plus `cube` (a running VM), `ghost` (a dashed outline), `check` and `cross`.
- **Brand:** `lockup()`, drawn from `docs/brand/lockup-dark.svg`, and the agent logos, copied from `docs/hero.py`.
- **The isometric world:** `P(gx, gy, gz)` projects grid coordinates to the screen. `isoBox`, `isoCube`, `isoGhost`, `callout` and `bar` build the scene on it.
- **The chat:** the `CHAT` list holds each message, tool call and result with its start time. `chat(r)` lays them out and scrolls them.
- **world(r):** what each tool call does to the cubes, keyed to the same times as `CHAT`.
- **The brand and outro:** the lockup's one continuous path from the title to the corner to the end card, then the end card and the works-with scene.

To change the story, edit `CHAT` and the matching moments in `world(r)` together. To make a new video, copy `promo.html` and keep everything above the timeline. The `promo-video` skill in [`.claude/skills/promo-video`](../../.claude/skills/promo-video/SKILL.md) walks through the whole process.
