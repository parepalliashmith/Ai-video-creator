# Free AI Video Creator

Turn a topic into a narrated MP4 video — for free. Node/Express server + a plain
HTML/CSS/JS frontend, no build step, no database, no account.

## Modes

- **Scene Video** (reliable, 100% free): enter a topic → Google Gemini (free tier)
  writes a scene-by-scene script → Gemini generates one AI image per scene (or
  use your own uploaded photos) → free narration audio (Google Translate TTS,
  no key needed) → ffmpeg renders Ken Burns pans, burned-in captions, and an
  optional procedurally-generated ambient music bed into a single MP4.
  Note: Gemini's free-tier image model (`gemini-2.5-flash-image`) currently
  returns a quota of 0 on plain AI Studio keys (Google requires billing linked
  to unlock it, even if usage then stays free). If image generation fails, the
  app automatically falls back to a free stock photo (Pexels, no card needed)
  when `PEXELS_API_KEY` is set — otherwise use "Upload my photos" instead.
- **Experimental AI Clip** (best-effort): true text-to-video via Hugging Face's
  free serverless Inference API. Slow, low-res, and may be unavailable on the
  free tier — clearly labeled, degrades gracefully.

## Run locally

```
npm install
set GEMINI_API_KEY=your-free-key-here   (PowerShell: $env:GEMINI_API_KEY="...")
node server.js
```

Open http://localhost:3000.

Get a free Gemini key at https://aistudio.google.com/apikey — you can pass
several comma-separated keys in `GEMINI_API_KEY` to rotate across daily quotas.

`PEXELS_API_KEY` is optional (free, no card — https://www.pexels.com/api/) and
enables the stock-photo fallback described above.

`HUGGINGFACE_API_KEY` is optional and only powers the experimental clip mode
(free token at https://huggingface.co/settings/tokens).

## Deploy

`render.yaml` deploys this as one free Render web service. Set `GEMINI_API_KEY`
(and optionally `PEXELS_API_KEY` / `HUGGINGFACE_API_KEY`) in the Render
dashboard's environment variables after the first deploy.

Note: the free plan's filesystem is ephemeral — generated videos are cleaned
up automatically after an hour and don't need to persist across restarts.
