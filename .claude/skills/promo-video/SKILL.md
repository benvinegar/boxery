---
name: promo-video
description: Make a new boxery promo or social video, or change one, in the brand's isometric style. Every video shares the same opening and closing tagline beats; the story in between is new each time. Use when asked for a promo, launch, feature, social or demo video, or an animation of something boxery does.
---

# boxery promo video

A boxery video has three parts:

1. **The opening.** The mark builds over "Your coding agent deserves its own VMs", then the lockup glides to the corner.
2. **A story.** This is different in every video.
3. **The close.** The end card has the tagline, the install command and the repo, followed by the works-with scene.

The opening and close are already built in `docs/promo/promo.html`. Don't change them unless the user asks to change the brand. Your job is the story, told so it looks like it belongs with every other boxery picture.

Read these first:

- `docs/brand/style.md`: colors, type, the isometric language, motion, words, and the "A promo video" section. The style matters more than anything else in this skill. When a story idea doesn't fit the style, change the idea.
- `docs/promo/README.md`: which parts of `promo.html` to keep and which to replace, and how to render.
- `README.md` and `docs/`: what boxery does today. Every claim in a story has to be true of the current code.

## 1. Agree the story before writing any code

Find out what the video is for: a feature, a use case, a launch, or a general introduction. Then propose two to four story scripts and let the user pick one. Each script is a short table of time, what is on screen, and the words on screen.

- A story shows one outcome someone wants, start to finish. Show it happening, not a list of features.
- The README's use cases are a good place to look for stories.
- Check every tool call, output line and timing against `mcp/`, `controller/`, `docs/cli.md` and the other docs. Use real names and numbers.
- Check what's physically true, not just what's in the code. For example, an agent running on the laptop stops when the laptop closes.
- Follow the style guide's "Words" section. Read the lines aloud, and cut anything that sounds like a launch video.
- Budget the time: the opening takes 2.3 s and the close about 7.7 s, so a 30 s video has about 20 s of story. That's six to ten beats.
- Decide how the story is told. It could be an agent's chat next to the isometric world, as in the current file, or the world on its own with short captions. Either way, the isometric world is where things happen.

If the story needs something the style guide hasn't drawn yet (a new kind of object or a new layout), make two or three still frames of it first and let the user choose before you animate.

## 2. Build it

- Copy `docs/promo/promo.html` to a new file named for the story (for example `docs/promo/<story>.html`). Edit `promo.html` itself only if the user wants the main video changed.
- Replace only what's between the `// ==== the story` and `// ==== the fixed opening and close` comments, and set `STORY` to the story's length. Keep everything else.
- Draw with the shared vocabulary: `isoBox`, `isoTile`, `isoCube`, `isoGhost`, `callout`, `bar`, `check`, `cross` and `key`. Draw a VM in a given state the way the style guide's state table says. If you need a new kind of object, add a helper next to the others, built from the same parts and colors.
- Animate only with `seg()` plus an easing. Don't use `Date.now()` or random numbers, so every frame can be rendered again exactly.
- Keep each beat's timing in one place. If there's a chat, its `CHAT` times and the moments in `world(r)` use the same clock: seconds since the story began.
- `story(r)` has to fade out by `STORY`, so the lockup can glide back for the end card.

## 3. Review with stills, and look at them

Render stills at every beat, and look at each PNG yourself:

```sh
node docs/promo/render.mjs docs/promo/<story>.html --stills 1,2.5,5,8,11,14,17,20,24,28 <scratch dir>
```

After the full render, make a contact sheet of the whole video:

```sh
ffmpeg -i out.mp4 -vf "fps=0.5,scale=360:-1,tile=5x3" -frames:v 1 sheet.png
```

Look for these:

- **Style drift:**
  - colors outside the palette
  - green used for something that isn't boxery or a good result
  - perspective or rotation
  - hard cuts
  - a second lockup
- **Text:**
  - text or labels clipped at the frame's edge (right-align labels near the right edge)
  - labels, bars and icons colliding with each other
  - text that isn't on screen long enough to read
- **Objects:**
  - things hidden under a panel (move the camera with `ISO.u` and `ISO.oy` rather than moving the panel)
  - iso objects lined up one behind another, which reads as a stack (spread them along the front row instead)
- **Scenes:**
  - an empty gap between beats
  - two headlines on screen together during a cross-fade
- **Code:**
  - `==>` or `->` turned into a ligature (use JetBrains Mono NL)
  - a local variable shadowing a helper such as `back` or `out`, which fails silently
  - a shape "drawn on" with `setLineDash` that keeps the dash once it's complete. A single dash the length of a closed outline is still an open line: its ends meet with flat caps and no join, which leaves a notch at the start corner. Set the dash only while the drawing is under 1, and stroke the finished shape solid.
- **The opening and close:**
  - they must still look exactly like the main video's
  - compare stills at 1 s, `S_END + 2` and `DUR - 1` with the same frames from `promo.html`
  - matching `promo.html` only shows you didn't change it, not that it's right. Check the mark against `docs/brand/mark-dark.svg` as well: all six corners of the hexagon rounded, with no gaps or notches.

Small details don't show in a whole 1080 px frame, because the frame shrinks when you view it. For the mark, icons, corners and joins, crop and enlarge them before you judge them:

```sh
ffmpeg -i t1.00.png -vf "crop=200:120:440:300,scale=800:-1:flags=neighbor" zoom.png
```

## 4. Render and hand it over

```sh
npm install --no-save playwright-core   # once
node docs/promo/render.mjs docs/promo/<story>.html       # writes docs/promo/<story>.mp4
```

The output is H.264 with yuv420p and faststart, which X, LinkedIn and Bluesky accept. There's no audio. Send the mp4 to the user. Commit the `.html` source, not the mp4: the video can always be rebuilt, and each mp4 adds about 2 MB to the repo's history.
