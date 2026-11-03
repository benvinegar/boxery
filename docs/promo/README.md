# boxery promo video

← [Back to the docs](../README.md)

These are boxery's social videos, written as code: a fixed opening and close around a story that's different in each video. They're drawn in the [boxery visual style](../brand/style.md), and its "A promo video" section describes the opening and close. The rendered mp4 isn't committed, so you build it from this folder.

| File | What it is |
|---|---|
| `promo.html` | A video as one canvas, drawn by `renderFrame(t)` for any time `t` in seconds. The story in the current file is an agent fixing failing tests by forking a VM three ways. |
| `render.mjs` | Steps `renderFrame` in headless Chrome at 30 fps and pipes the frames to ffmpeg. It can also write review stills. |

## Watch it

Open `promo.html` in Chrome. It loops. Add `?t=12.5` to the URL to freeze on a moment, and press space to pause or resume.

## Render it

You need Google Chrome, ffmpeg and playwright-core:

```sh
npm install --no-save playwright-core
node docs/promo/render.mjs                                  # writes docs/promo/boxery-promo.mp4
node docs/promo/render.mjs --stills 3,8,13,18,24,28 /tmp/s  # PNGs at those times
node docs/promo/render.mjs docs/promo/other.html           # another video page; writes other.mp4
```

To check the whole video at once, make a contact sheet with one frame every 2 s:

```sh
ffmpeg -i docs/promo/boxery-promo.mp4 -vf "fps=0.5,scale=360:-1,tile=5x3" -frames:v 1 sheet.png
```

## How promo.html is laid out

| Section | What it holds | In a new video |
|---|---|---|
| Timing, primitives, cubes, brand, background | Easings, `text`, `rrect`, `cube`, `ghost`, `check`, `cross`, `lockup`, the agent logos, the dot grid and the bottom bar | Keep |
| Timeline | `T0` (when the opening ends), `STORY` (how long the story runs) and the derived `S_END` and `DUR` | Change `STORY` |
| The isometric world | `P(gx, gy, gz)` and `isoBox`, `isoTile`, `isoCube`, `isoGhost`, `callout`, `bar`, `key`, the vocabulary every story draws with | Keep, and add to it |
| **The story** (between the `====` markers) | This video's `CHAT`, `chat(r)` and `world(r)` | Replace |
| **The fixed opening and close** | `brand(t)`, `title(t)` and `outro(t)` | Keep |

`story(r)` gets the time since the story began, and it has to fade out by `STORY` so the lockup can glide back for the end card. A story doesn't have to be a chat with an agent, but if it is, `chat(r)` can be reused with a new `CHAT` list. The `promo-video` skill in [`.claude/skills/promo-video`](../../.claude/skills/promo-video/SKILL.md) walks an agent through making a new one.
