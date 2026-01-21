// server.js
import express from "express";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/render", async (req, res) => {
  try {
    const {
      snapUrl,
      browserToken,
      format = "gif", // gif|mp4
      w = 800,
      h = 1200,
      frames = 30,
      delay = 24,
      scale = 0.6,
      colors = 48,
      wmEnabled = 0,
      wmText = "textoverimages.com",
      wmSize = 28,
      wmOpacity = 45,
      wmPos = "center",
    } = req.body || {};

    if (!snapUrl || !browserToken) {
      return res.status(400).json({ ok: false, error: "Missing snapUrl or browserToken" });
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "toi-"));
    const framesDir = path.join(tmp, "frames");
    fs.mkdirSync(framesDir);

    // -------------------------------------------------------
    // 1) CAPTURE FRAMES HERE
    // -------------------------------------------------------
    // TODO: Replace this part with your existing capture logic
    // It should create PNG files like:
    // frames/frame-0001.png, frame-0002.png ... etc.
    //
    // For now we just fail clearly:
    throw new Error("TODO: plug your existing frame-capture code here (Browserless/Puppeteer)");

    // -------------------------------------------------------
    // 2) ENCODE (GIF or MP4)
    // -------------------------------------------------------
    // const inputPattern = path.join(framesDir, "frame-%04d.png");
    // if (format === "mp4") { ... ffmpeg mp4 ... } else { ... gif ... }

  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/health", (req, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("listening on", PORT));
