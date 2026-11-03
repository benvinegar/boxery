#!/usr/bin/env node
// Draws card.svg, this finding's social card, from the summary in results.json.
//
// usage: node docs/research/2026-11-03-hunk-suite-vm-vs-macos/make-card.mjs
//
// Each bar's length is the mean wall time at 2 shards, and its lighter end is the kernel's share of
// CPU time. Rows: macOS, then boxery (Lima) beside Docker at each matched size. Colors and type follow
// docs/brand/style.md: green only for boxery, warm greys for everything else. The lockup and mark
// are inlined from docs/brand so the card is one self-contained file.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const brand = join(here, "../../brand");
const { summary } = JSON.parse(readFileSync(join(here, "results.json"), "utf8"));

/** @param {string} env */
const row = (env) => {
  const r = summary.find((/** @type {{ env: string, setting?: string }} */ s) => s.env === env && s.setting === "2 shards");
  if (!r) throw new Error(`no 2-shard summary for ${env}`);
  return r;
};

/** Inner markup of a brand SVG, for nesting in an <svg> with the same viewBox. @param {string} file */
const inner = (file) => readFileSync(join(brand, file), "utf8").replace(/^<svg[^>]*>|<\/svg>\s*$/g, "");

const W = 2000, H = 1125;
const C = {
  bg: "#2C2C2A", ink: "#F1EFE8", green: "#1D9E75", ghost: "#5DCAA5", secondary: "#B4B2A9",
  muted: "#888780", dim: "#5F5E5A", track: "#444441",
};
const SANS = "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono NL', 'JetBrains Mono', ui-monospace, Menlo, monospace";

const X0 = 680; // where bars start
const PX = 9.5; // pixels per second of wall time
const BAR = 32;
const GAP = 3; // between a bar's app and kernel parts

/**
 * One stacked bar with its wall time after it.
 * @param {number} cy  vertical centre
 * @param {{ real_s: number, kernel_share: number }} r
 * @param {boolean} boxery
 */
function bar(cy, r, boxery) {
  const total = r.real_s * PX;
  const kernel = Math.round(total * r.kernel_share);
  const app = Math.round(total) - kernel - GAP;
  const y = cy - BAR / 2;
  const [appFill, kernelFill, numberFill] = boxery ? [C.green, C.ghost, C.ghost] : [C.dim, C.muted, C.ink];
  const kx = X0 + app + GAP;
  return [
    `<rect x="${X0}" y="${y}" width="${app}" height="${BAR}" rx="6" fill="${appFill}"/>`,
    `<rect x="${kx}" y="${y}" width="${kernel}" height="${BAR}" rx="6" fill="${kernelFill}"/>`,
    `<text x="${kx + kernel / 2}" y="${cy + 8}" text-anchor="middle" font-family="${SANS}" font-size="21" font-weight="700" fill="${C.bg}">${Math.round(r.kernel_share * 100)}%</text>`,
    `<text x="${kx + kernel + 24}" y="${cy + 15}" font-family="${SANS}" font-size="40" font-weight="700" letter-spacing="-1" fill="${numberFill}">${Math.round(r.real_s)}s</text>`,
  ].join("\n  ");
}

/** A tool tag left of a bar. @param {number} cy @param {boolean} boxery */
function tag(cy, boxery) {
  if (!boxery) return `<text x="444" y="${cy + 9}" font-family="${MONO}" font-size="26" fill="${C.secondary}">Docker</text>`;
  return [
    `<svg x="408" y="${cy - 15}" width="30" height="30" viewBox="0 0 64 64">${inner("mark-dark.svg")}</svg>`,
    `<text x="444" y="${cy + 9}" font-family="${MONO}" font-size="26" fill="${C.ghost}">boxery <tspan fill="${C.muted}">(Lima)</tspan></text>`,
  ].join("\n  ");
}

const sizes = [
  { label: "2 CPU · 4 GB", lima: "lima-small", docker: "docker-2cpu", cy: 590 },
  { label: "4 CPU · 8 GB", lima: "lima-standard", docker: "docker-4cpu", cy: 752 },
  { label: "8 CPU · 16 GB", lima: "lima-large", docker: "docker-8cpu", cy: 914 },
];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="hunk's 5,211-test suite on one M5 Max Mac: ${Math.round(row("macos").real_s)} s on macOS, ${sizes.map((s) => `${Math.round(row(s.lima).real_s)} s in a ${s.label} boxery VM and ${Math.round(row(s.docker).real_s)} s in Docker`).join("; ")}">
  <defs><pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse" x="${(W % 32) / 2}" y="${(H % 32) / 2}"><circle cx="16" cy="16" r="1.6" fill="${C.ink}"/></pattern></defs>
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#dots)" opacity="0.07"/>
  <rect x="0" y="${H - 12}" width="${W / 2}" height="12" fill="${C.green}"/>
  <rect x="${W / 2}" y="${H - 12}" width="${W / 2}" height="12" fill="#0F6E56"/>

  <svg x="104" y="84" width="241" height="64" viewBox="0 0 241 64">${inner("lockup-dark.svg")}</svg>
  <text x="1880" y="130" text-anchor="end" font-family="${SANS}" font-size="30" fill="${C.muted}">hunk test suite · <tspan fill="${C.ink}" font-weight="600">5,211</tspan> tests · M5 Max</text>

  <text x="120" y="262" font-family="${SANS}" font-size="88" font-weight="700" letter-spacing="-2" fill="${C.ink}">Same machine, <tspan fill="${C.ghost}">faster in Linux VMs.</tspan></text>

  <text x="${X0}" y="380" font-family="${MONO}" font-size="22" letter-spacing="4" fill="${C.muted}">WALL TIME</text>
  <rect x="${X0 + 178}" y="362" width="20" height="20" rx="4" fill="${C.dim}"/>
  <text x="${X0 + 208}" y="380" font-family="${SANS}" font-size="26" fill="${C.secondary}">app</text>
  <rect x="${X0 + 276}" y="362" width="20" height="20" rx="4" fill="${C.muted}"/>
  <text x="${X0 + 306}" y="380" font-family="${SANS}" font-size="26" fill="${C.secondary}">kernel share of CPU time</text>

  <text x="120" y="472" font-family="${SANS}"><tspan font-size="34" font-weight="600" fill="${C.ink}">macOS</tspan><tspan dx="14" font-size="30" fill="${C.muted}">no VM</tspan></text>
  ${bar(460, row("macos"), false)}

  ${sizes
    .map(
      (s) => `<text x="120" y="${s.cy + 36}" font-family="${SANS}" font-size="34" font-weight="600" fill="${C.ink}">${s.label}</text>
  ${tag(s.cy, true)}
  ${bar(s.cy, row(s.lima), true)}
  ${tag(s.cy + 52, false)}
  ${bar(s.cy + 52, row(s.docker), false)}`,
    )
    .join("\n\n  ")}

  <text x="1880" y="1068" text-anchor="end" font-family="${SANS}" font-size="22" fill="${C.dim}">2 test shards everywhere · mean of 2 runs · Docker's 8-CPU run had Docker Desktop's 7.65 GB</text>
</svg>
`;

writeFileSync(join(here, "card.svg"), svg);
console.log(`wrote ${join(here, "card.svg")}`);
