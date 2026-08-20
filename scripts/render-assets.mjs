#!/usr/bin/env node
/**
 * Renders the image assets from the mark and the site's own type.
 *
 * They are committed, not built: the site build must not need a browser. This
 * exists so nobody has to reverse-engineer a PNG later. Run it, commit what
 * changes, and the reasoning stays beside the pixels.
 *
 *   node scripts/render-assets.mjs
 *
 * Requires a local Chrome. The page is assembled in memory with the font
 * inlined, so nothing is fetched and the output does not depend on a server.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9444;

const HEX = "M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z";
const PULSE = "M6.8 14.7 H9.8 V9.3 H14.2 V14.7 H17.2";

const mark = (px) => `
  <svg width="${px}" height="${px}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <mask id="p">
      <rect width="24" height="24" fill="#fff"/>
      <path d="${PULSE}" stroke="#000" stroke-width="2.1" stroke-linecap="round"
            stroke-linejoin="round" fill="none"/>
    </mask>
    <path d="${HEX}" fill="#fff" mask="url(#p)"/>
  </svg>`;

const font = readFileSync("public/fonts/instrument-sans-var.woff2").toString("base64");

const page = (body, css = "") => `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: Instrument; src: url(data:font/woff2;base64,${font}) format('woff2');
               font-weight: 100 900; font-display: block }
  * { margin: 0; box-sizing: border-box }
  html, body { background: #000; font-family: Instrument, sans-serif;
               -webkit-font-smoothing: antialiased }
  ${css}
</style>${body}`;

/* The icon is full-bleed on black. iOS applies its own rounded mask and does not
   honour transparency, so a square with the mark inset is the only shape that
   survives every platform intact. */
const icon = (px) =>
  page(
    `<div class="i">${mark(Math.round(px * 0.62))}</div>`,
    `.i { width: ${px}px; height: ${px}px; display: grid; place-items: center; background: #000 }`
  );

/* The share card. Whatever renders it crops and scales, so nothing sits near an
   edge and the type is large enough to survive a thumbnail in a chat list. */
const share = page(
  `<div class="c">
     <div class="row">${mark(56)}<span class="brand">Quartz Labs</span></div>
     <p class="claim">We design, build and operate software systems</p>
     <p class="sub">Mobile and web applications, the services behind them, and the
       infrastructure they depend on.</p>
   </div>`,
  `.c { width: 1200px; height: 630px; padding: 88px; display: flex; flex-direction: column;
        justify-content: center; gap: 40px; color: #fff;
        background: #000 radial-gradient(60% 420px at 50% 0%, #ffffff14, transparent) }
   .row { display: flex; align-items: center; gap: 20px }
   .brand { font-size: 34px; font-weight: 600; letter-spacing: -0.015em }
   .claim { font-size: 68px; font-weight: 600; letter-spacing: -0.035em; line-height: 1.02;
            max-width: 15ch }
   .sub { font-size: 26px; line-height: 1.45; color: #a3a3a3; max-width: 34ch }`
);

const ASSETS = [
  { file: "public/og.png", w: 1200, h: 630, html: share },
  { file: "public/apple-touch-icon.png", w: 180, h: 180, html: icon(180) },
  // Declared as the Organization's logo in the structured data. Google wants a
  // raster of at least 112px for the entity card, and will not take an SVG.
  { file: "public/logo.png", w: 512, h: 512, html: icon(512) },
  { file: "public/favicon-32.png", w: 32, h: 32, html: icon(32) },
  // Google recommends a favicon larger than 48x48 for the search result, and 32
  // was the largest raster offered as rel="icon". The search listing showed the
  // default globe. That is mostly a matter of Googlebot-Image not having crawled
  // yet, which takes days, but 32 was also the one thing below their guideline.
  { file: "public/favicon-48.png", w: 48, h: 48, html: icon(48) },
  { file: "public/favicon-192.png", w: 192, h: 192, html: icon(192) },
];

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--user-data-dir=/tmp/quartz-render",
    "about:blank",
  ],
  { stdio: "ignore" }
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

const { WebSocket } = await import("ws");
for (const a of ASSETS) {
  const t = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const pending = new Map();
  ws.on("message", (m) => {
    const d = JSON.parse(m);
    if (pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: a.w,
    height: a.h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.setDocumentContent", {
    frameId: (await send("Page.getFrameTree")).result.frameTree.frame.id,
    html: a.html,
  });
  await sleep(900);
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: a.w, height: a.h, scale: 1 },
  });
  writeFileSync(a.file, Buffer.from(shot.result.data, "base64"));
  console.log(`${a.file}  ${a.w}x${a.h}`);
  ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
}
chrome.kill();
process.exit(0);
