// Render promo.html to an MP4, frame by frame, in headless Chrome.
//
//   npx -y -p playwright-core node docs/promo/render.mjs [out.mp4]
//   node docs/promo/render.mjs --stills 2,7,12 [dir]    # PNGs at those times, for review
//
// Needs Google Chrome and ffmpeg. PLAYWRIGHT=/path/to/playwright-core overrides the import.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : 'playwright-core');
const here = dirname(fileURLToPath(import.meta.url));
const FPS = 30;

const args = process.argv.slice(2);
const stills = args[0] === '--stills' ? args[1].split(',').map(Number) : null;
const target = resolve(stills ? args[2] ?? join(here, 'stills') : args[0] ?? join(here, 'boxery-promo.mp4'));

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'promo.html')).href + '?render');
await page.evaluate(() => document.fonts.ready);
const canvas = page.locator('canvas');
const frame = async t => { await page.evaluate(t => window.renderFrame(t), t); return canvas.screenshot({ type: 'png' }); };

if (stills) {
  mkdirSync(target, { recursive: true });
  for (const t of stills) writeFileSync(join(target, `t${t.toFixed(2)}.png`), await frame(t));
} else {
  const dur = await page.evaluate(() => window.DUR);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round(dur * FPS);
  for (let i = 0; i < n; i++) {
    const buf = await frame(i / FPS);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % FPS === 0) process.stdout.write(`\r${(i / FPS).toFixed(0)}s / ${dur}s`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on('close', c => (c ? j(new Error(`ffmpeg exited ${c}`)) : r())));
  console.log(`\r${target}`);
}
await browser.close();
