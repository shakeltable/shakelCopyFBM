// server.js (MP4 ONLY worker)
// - Captures scrolling frames using Browserless (puppeteer-core connect)
// - Encodes MP4 using ffmpeg
//
// POST /render JSON:
// {
//   "snapUrl": "https://example.com",
//   "browserToken": "BROWSERLESS_TOKEN",
//   "w": 800,
//   "h": 1200,
//   "frames": 30,
//   "delay": 24,         // 1/100 sec per frame (like GIF delay), used to compute FPS
//   "animPx": 20,        // scroll pixels per frame
//   "wait": 800          // ms extra wait after goto
// }
//
// Returns: raw MP4 bytes (Content-Type: video/mp4)
//
// Optional secret header:
// - Set env TOI_SECRET
// - Client must send header: X-TOI-SECRET: <value>

import express from "express";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import puppeteer from "puppeteer-core";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

// If you set this in Cloud Run env vars, requests must include X-TOI-SECRET header
const TOI_SECRET = process.env.TOI_SECRET || "";
const TOI_SECRET_HEADER = process.env.TOI_SECRET_HEADER || "X-TOI-SECRET";

// Browserless WS base (no token). We will append ?token=...
// Good defaults (use the one that works for your Browserless plan/region):
const BROWSERLESS_WS_BASE =
  process.env.BROWSERLESS_WS_BASE ||
  "wss://production-sfo.browserless.io/?token=";

// Safety limits
const MAX_RENDER_MS = Number(process.env.MAX_RENDER_MS || 180000); // 180s
const MAX_OUT_BYTES = Number(process.env.MAX_OUT_BYTES || 12 * 1024 * 1024); // 12MB
const MAX_FRAMES = Number(process.env.MAX_FRAMES || 60);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function requireSecretOrReject(req, res) {
  if (!TOI_SECRET) return true; // no secret configured
  const got = (req.headers[TOI_SECRET_HEADER.toLowerCase()] || "").toString().trim();
  if (!got || got !== TOI_SECRET) {
    res.status(401).json({ ok: false, error: "Unauthorized (bad/missing secret)" });
    return false;
  }
  return true;
}

async function captureScrollingFrames({
  snapUrl,
  browserToken,
  w,
  h,
  frames,
  animPx,
  wait,
  rid,
}) {
  const ws = `${BROWSERLESS_WS_BASE}${encodeURIComponent(browserToken)}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "toi-"));
  const framesDir = path.join(tmp, "frames");
  fs.mkdirSync(framesDir);

  const browser = await puppeteer.connect({
    browserWSEndpoint: ws,
  });

  let page;
  try {
    page = await browser.newPage();

    // viewport
    await page.setViewport({
      width: w,
      height: h,
      deviceScaleFactor: 1,
    });

    // Go
    await page.goto(snapUrl, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    if (wait > 0) await sleep(wait);

    // Try to ensure fonts/images settle a bit
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    // Determine scroll height
    const doc = await page.evaluate(() => {
      const el = document.documentElement;
      const body = document.body;
      return {
        scrollHeight: Math.max(el.scrollHeight, body ? body.scrollHeight : 0),
        clientHeight: el.clientHeight,
      };
    });

    // If page is short, still capture at least 1 frame
    const maxScrollTop = Math.max(0, doc.scrollHeight - h);

    // If user passed frames, respect it. If not, compute from animPx.
    let totalFrames = Math.max(1, Math.min(MAX_FRAMES, Number(frames || 0) || 0));
    if (!totalFrames || totalFrames < 1) {
      const px = Math.max(5, Math.min(240, Number(animPx || 20)));
      totalFrames = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(maxScrollTop / px) + 1));
    }

    const stepPx = Math.max(5, Math.min(240, Number(animPx || 20)));

    // Capture
    let scrollTop = 0;

    for (let i = 1; i <= totalFrames; i++) {
      // Scroll
      await page.evaluate((y) => window.scrollTo(0, y), scrollTop);

      // Small wait for layout/paint
      await sleep(60);

      // Screenshot (viewport)
      const buf = await page.screenshot({
        type: "png",
        fullPage: false,
        captureBeyondViewport: false,
      });

      const fname = `frame-${String(i).padStart(4, "0")}.png`;
      fs.writeFileSync(path.join(framesDir, fname), buf);

      // next scroll
      scrollTop = Math.min(maxScrollTop, scrollTop + stepPx);
      if (scrollTop >= maxScrollTop) {
        // If we reached bottom early, still keep frames consistent:
        // just keep capturing at bottom for the remaining frames.
      }
    }

    return { tmp, framesDir, frameCount: totalFrames };
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      await browser.disconnect();
    } catch {}
  }
}

async function encodeMp4({ tmp, framesDir, delay }) {
  const inputPattern = path.join(framesDir, "frame-%04d.png");
  const outMp4 = path.join(tmp, "out.mp4");

  // delay is 1/100 sec per frame
  // fps = 100 / delay
  let fps = Math.round(100 / Math.max(1, Number(delay || 24)));
  fps = Math.max(1, Math.min(30, fps));

  await new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        String(fps),
        "-i",
        inputPattern,
        "-vf",
        "format=yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-movflags",
        "+faststart",
        outMp4,
      ],
      { timeout: MAX_RENDER_MS },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || String(err)));
        resolve();
      }
    );
  });

  const bytes = fs.readFileSync(outMp4);
  return bytes;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/render", async (req, res) => {
  const rid = "toi_" + Math.random().toString(16).slice(2, 10);

  try {
    if (!requireSecretOrReject(req, res)) return;

    const body = req.body || {};

    const snapUrl = safeUrl((body.snapUrl || "").toString().trim());
    const browserToken = (body.browserToken || "").toString().trim();

    if (!snapUrl) return res.status(400).json({ ok: false, rid, error: "Invalid snapUrl" });
    if (!browserToken) return res.status(400).json({ ok: false, rid, error: "Missing browserToken" });

    // MP4 ONLY
    const w = Math.max(480, Math.min(1920, Number(body.w || 800)));
    const h = Math.max(300, Math.min(2000, Number(body.h || 1200)));
    const frames = Math.max(1, Math.min(MAX_FRAMES, Number(body.frames || 30)));
    const delay = Math.max(1, Math.min(60, Number(body.delay || 24)));
    const animPx = Math.max(5, Math.min(240, Number(body.animPx || body.anim_px || 20)));
    const wait = Math.max(0, Math.min(8000, Number(body.wait || 800)));

    // 1) Capture frames
    const cap = await captureScrollingFrames({
      snapUrl,
      browserToken,
      w,
      h,
      frames,
      animPx,
      wait,
      rid,
    });

    // 2) Encode MP4
    const mp4Bytes = await encodeMp4({
      tmp: cap.tmp,
      framesDir: cap.framesDir,
      delay,
    });

    // Cleanup temp
    cleanupDir(cap.tmp);

    if (!mp4Bytes || mp4Bytes.length < 1000) {
      return res.status(500).json({ ok: false, rid, error: "MP4 output empty/invalid" });
    }
    if (mp4Bytes.length > MAX_OUT_BYTES) {
      return res.status(413).json({ ok: false, rid, error: `MP4 too large (> ${MAX_OUT_BYTES} bytes)` });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(mp4Bytes);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      rid,
      error: String(err?.message || err),
    });
  }
});

app.listen(PORT, () => console.log("listening on", PORT));
