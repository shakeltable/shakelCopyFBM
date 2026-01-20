from flask import Flask, request, jsonify, Response
import os, time, json, subprocess, tempfile, shutil
import requests
from PIL import Image

app = Flask(__name__)

def _fail(msg, code=400, extra=None):
    payload = {"ok": False, "error": msg}
    if extra:
        payload.update(extra)
    return jsonify(payload), code

@app.route("/", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "toi-gif-worker", "status": "ready"})

@app.route("/render", methods=["POST"])
def render():
    # Optional: simple shared-secret (HIGHLY recommended)
    secret = os.environ.get("TOI_SECRET", "").strip()
    if secret:
        got = request.headers.get("X-TOI-SECRET", "").strip()
        if got != secret:
            return _fail("Unauthorized", 401)

    data = request.get_json(silent=True) or {}

    snap_url = (data.get("snapUrl") or "").strip()
    browser_token = (data.get("browserToken") or "").strip()
    browser_endpoint = (data.get("browserEndpoint") or "https://production-sfo.browserless.io/screenshot").strip()
    wait_ms = int(data.get("waitMs") or 800)

    view_w = int(data.get("w") or 800)
    view_h = int(data.get("h") or 1200)
    frames = int(data.get("frames") or 36)
    delay = int(data.get("delay") or 22)  # 1/100 sec (gif)
    loop = int(data.get("loop") or 0)     # 0 once, 1 infinite (we map later)
    scale = float(data.get("scale") or 0.65)
    colors = int(data.get("colors") or 64)

    # clamps (keep worker safe)
    if not snap_url:
        return _fail("Missing snapUrl")
    if not browser_token:
        return _fail("Missing browserToken (user Browserless token)")
    view_w = max(480, min(1200, view_w))
    view_h = max(300, min(1400, view_h))
    wait_ms = max(0, min(8000, wait_ms))
    frames = max(6, min(60, frames))
    delay = max(1, min(40, delay))
    scale = max(0.35, min(0.85, scale))
    colors = max(16, min(128, colors))

    t0 = time.time()

    # 1) Browserless full page PNG
    endpoint = browser_endpoint
    if "token=" in endpoint:
        url = endpoint
    else:
        url = endpoint + ("&" if "?" in endpoint else "?") + "token=" + requests.utils.quote(browser_token)

    payload = {
        "url": snap_url,
        "options": {"type": "png", "fullPage": True, "omitBackground": False},
    }
    if wait_ms > 0:
        payload["waitForTimeout"] = wait_ms

    try:
        r = requests.post(url, json=payload, timeout=120)
    except Exception as e:
        return _fail("Browserless request failed", 502, {"details": str(e)})

    if r.status_code != 200 or not r.content:
        preview = r.text[:1200] if r.text else ""
        return _fail("Browserless returned non-200", 502, {
            "http_code": r.status_code,
            "body_preview": preview
        })

    png_bytes = r.content
    if len(png_bytes) < 2000 or not png_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return _fail("Browserless response is not a valid PNG", 502)

    # 2) Build frames by cropping the long PNG
    tmpdir = tempfile.mkdtemp(prefix="toi_")
    try:
        png_path = os.path.join(tmpdir, "full.png")
        with open(png_path, "wb") as f:
            f.write(png_bytes)

        img = Image.open(png_path).convert("RGBA")

        # resize to target width first
        if img.width != view_w:
            new_h = int(round(img.height * (view_w / img.width)))
            img = img.resize((view_w, new_h), Image.LANCZOS)

        # apply scale (quality/cost control)
        if abs(scale - 1.0) > 0.001:
            new_w = max(320, int(round(img.width * scale)))
            new_h = int(round(img.height * (new_w / img.width)))
            img = img.resize((new_w, new_h), Image.LANCZOS)

        w = img.width
        h = img.height

        view_h2 = int(round(view_h * scale))
        view_h2 = max(240, min(view_h2, h))

        max_y = max(0, h - view_h2)
        if max_y == 0:
            frames = 1

        frames_dir = os.path.join(tmpdir, "frames")
        os.makedirs(frames_dir, exist_ok=True)

        for i in range(frames):
            t = 0.0 if frames <= 1 else (i / (frames - 1))
            y = int(round(max_y * t))
            crop = img.crop((0, y, w, y + view_h2))
            out_path = os.path.join(frames_dir, f"f_{i:03d}.png")
            crop.save(out_path, "PNG", optimize=True)

        # 3) FFmpeg → GIF with palette for better quality
        palette = os.path.join(tmpdir, "palette.png")
        gif_path = os.path.join(tmpdir, "out.gif")

        # Make palette
        cmd1 = [
            "ffmpeg", "-y",
            "-framerate", str(max(1, int(round(100 / delay)))),  # approx
            "-i", os.path.join(frames_dir, "f_%03d.png"),
            "-vf", f"palettegen=max_colors={colors}",
            palette
        ]
        subprocess.run(cmd1, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # Use palette
        loops = "0" if loop == 1 else "1"  # gif: 0=infinite, 1=once (enough)
        cmd2 = [
            "ffmpeg", "-y",
            "-framerate", str(max(1, int(round(100 / delay)))),
            "-i", os.path.join(frames_dir, "f_%03d.png"),
            "-i", palette,
            "-lavfi", "paletteuse=dither=bayer:bayer_scale=5",
            "-loop", loops,
            gif_path
        ]
        subprocess.run(cmd2, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        with open(gif_path, "rb") as f:
            gif_bytes = f.read()

        dt = time.time() - t0
        # Return binary GIF
        resp = Response(gif_bytes, mimetype="image/gif")
        resp.headers["X-TOI-OK"] = "1"
        resp.headers["X-TOI-SECONDS"] = f"{dt:.2f}"
        resp.headers["X-TOI-BYTES"] = str(len(gif_bytes))
        return resp

    except subprocess.CalledProcessError:
        return _fail("FFmpeg failed to build GIF", 500)
    except Exception as e:
        return _fail("Worker exception", 500, {"details": str(e)})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
