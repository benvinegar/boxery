---
name: promo-video
description: Make or change a boxery promo or social video (or an animated still) in the brand's isometric style, using docs/promo/promo.html and render.mjs. Use when asked for a promo, launch, social or demo video, an animation of what boxery does, or edits to the existing promo.
---

# boxery promo video

The existing video is `docs/promo/promo.html`. It's a deterministic canvas animation, rendered with `docs/promo/render.mjs`. Read these before starting:

- `docs/brand/style.md`: colors, type, the isometric language, motion and words. Follow it.
- `docs/promo/README.md`: how `promo.html` is laid out and how to render it.
- `README.md` and `docs/`: what boxery does today. Every claim in a video has to be true of the current code.

## 1. Agree the script before writing any code

Propose two to four short scripts and let the user pick one. Each script is a table of time, what is on screen, and the words on screen.

- Lead with an outcome someone wants, not a feature list. The current video's story is "you ask for the tests in a VM; the agent makes one, forks it three ways to try three fixes, keeps the one that worked, and pushes with a key that never left the host".
- Use real tool calls, output and timings. Check them against `mcp/`, `controller/` and `docs/cli.md`.
- Mind what's physically true. For example, the agent runs on the laptop, so "close your laptop and it keeps going" is only true if the agent itself runs on a server.
- Words follow the "Words" section of the style guide. Read the script aloud, and cut anything that sounds like a product launch.
- 30 s is about 10 beats. The title takes about 2 s and the end card about 7 s.

If the user wants a different look, make two or three still frames first (with `--stills`) and let them choose before animating.

## 2. Build it

- Edit `docs/promo/promo.html`, or copy it to a new file for a new video. Keep the helpers above `// ---- timeline ----` and change what's below.
- Put story times in one place: the `CHAT` entries and the moments in `world(r)` use the same clock (seconds since `T0`).
- Draw VMs only with `cube`, `ghost`, `isoCube` and `isoGhost`, with each state meaning what the style guide says it means.
- Animate only with `seg()` plus an easing. Never use `Date.now()` or random numbers, so every frame can be rendered again exactly.
- The lockup is one object for the whole video (`brand(t)`), so move it rather than redrawing it in new places.

## 3. Review it with stills, and look at them

Render stills at every beat, and read each PNG yourself:

```sh
node docs/promo/render.mjs --stills 1,2.5,5,8,11,14,17,20,24,28 <scratch dir>
```

For a whole-video check after rendering, make a contact sheet:

```sh
ffmpeg -i out.mp4 -vf "fps=0.5,scale=360:-1,tile=5x3" -frames:v 1 sheet.png
```

Check each frame for these problems, which all came up in the first video:

- Text or labels clipped at the frame's edge. Right-align labels near the right edge.
- Labels, bars, ✓ and ✕ colliding with each other.
- Cubes hidden under the chat panel. Move the camera (`ISO.u`, `ISO.oy`) rather than the panel.
- Forks lined up behind each other so they read as a tower. Spread them along the front row of the platform.
- Two headlines on screen at once during a cross-fade. The old scene's exit has to finish first.
- `==>` or `->` turned into an arrow. Use JetBrains Mono NL.
- A local variable shadowing a helper such as `back`, `out` or `step`. This fails silently.
- Empty gaps between scenes with nothing on screen.

## 4. Render and hand it over

```sh
npm install --no-save playwright-core   # once
node docs/promo/render.mjs <out.mp4>
```

The output is H.264 with yuv420p and faststart, which X, LinkedIn and Bluesky accept. There's no audio. Send the mp4 to the user. Don't commit rendered mp4s: they can be rebuilt, and each one adds about 2 MB to the repo's history.
