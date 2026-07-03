// Free AI Video Creator — Node/Express server.
// Scene Video: topic -> AI script -> AI images (or uploaded photos) ->
// free narration -> ffmpeg render (Ken Burns + captions + optional music).
//
// (An experimental true text-to-video mode via Hugging Face's free
// serverless Inference API was tried and removed: that free endpoint has
// been retired, and its replacement gives free accounts only $0.10/month
// of credit — nowhere near enough for a single video-gen call.)

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';

import * as gemini from './lib/gemini.js';
import * as tts from './lib/tts.js';
import * as pexels from './lib/pexels.js';
import { renderVideo } from './lib/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const OUTPUT_DIR = path.join(__dirname, 'output');
const WORK_ROOT = path.join(__dirname, 'uploads', 'work');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(WORK_ROOT, { recursive: true });

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
});

const LANGUAGES = {
  en: 'English',
  te: 'Telugu (తెలుగు script)',
  hi: 'Hindi (हिन्दी / Devanagari script)',
};

// --- Job store (in-memory; ephemeral by design — no DB needed for a stateless tool) ---
const jobs = new Map();

function newJob(type) {
  const id = nanoid(10);
  const job = { id, type, status: 'queued', progress: '', error: null, resultPath: null, title: null, createdAt: Date.now() };
  jobs.set(id, job);
  return job;
}

// Periodic cleanup: drop finished output files/jobs after 1 hour (free tier disk is small).
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) {
      if (job.resultPath) fs.rm(job.resultPath, { force: true }, () => {});
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    geminiConfigured: gemini.isConfigured(),
    stockPhotoConfigured: pexels.isConfigured(),
  });
});

// ---------------------------------------------------------------------------
// Mode A: Scene Video
// ---------------------------------------------------------------------------
app.post('/api/video', upload.array('images', 20), async (req, res) => {
  if (!gemini.isConfigured()) {
    return res.status(503).json({ error: 'Video AI is not configured yet — set GEMINI_API_KEY on the server.' });
  }
  const topic = (req.body.topic || '').trim();
  if (!topic) return res.status(400).json({ error: 'Enter a topic or script to build a video from.' });

  const sceneCount = Math.min(Math.max(parseInt(req.body.sceneCount, 10) || 5, 2), 10);
  const orientation = req.body.orientation === 'portrait' ? 'portrait' : 'landscape';
  const langCode = LANGUAGES[req.body.lang] ? req.body.lang : 'en';
  const captionsOn = req.body.captionsOn !== 'false';
  const addMusic = req.body.addMusic === 'true';
  const fastMode = req.body.fastMode === 'true';
  const imageSource = req.body.imageSource === 'upload' ? 'upload' : 'ai';
  const uploadedImages = req.files || [];

  if (imageSource === 'upload' && !uploadedImages.length) {
    return res.status(400).json({ error: 'Upload at least one photo, or switch to AI-generated images.' });
  }

  const job = newJob('scene');
  res.json({ jobId: job.id });
  runSceneJob(job, { topic, sceneCount, orientation, langCode, captionsOn, addMusic, fastMode, imageSource, uploadedImages }).catch((e) => {
    job.status = 'error';
    job.error = e.message || 'Something went wrong.';
  });
});

async function runSceneJob(job, { topic, sceneCount, orientation, langCode, captionsOn, addMusic, fastMode, imageSource, uploadedImages }) {
  const workDir = path.join(WORK_ROOT, job.id);
  fs.mkdirSync(workDir, { recursive: true });

  job.status = 'script';
  job.progress = 'writing the script';
  const script = await gemini.generateScript(topic, sceneCount, orientation, LANGUAGES[langCode]);
  job.title = script.title || topic;

  const scenes = [];
  job.status = 'images';
  for (let i = 0; i < script.scenes.length; i++) {
    job.progress = `generating image ${i + 1}/${script.scenes.length}`;
    const scene = script.scenes[i];
    const imagePath = path.join(workDir, `image-${i}.png`);
    if (imageSource === 'upload') {
      const file = uploadedImages[i % uploadedImages.length];
      fs.writeFileSync(imagePath, file.buffer);
    } else {
      try {
        const { buffer } = await gemini.generateImage(scene.imagePrompt, orientation);
        fs.writeFileSync(imagePath, buffer);
      } catch (geminiErr) {
        if (!pexels.isConfigured()) throw geminiErr;
        job.progress = `AI image unavailable — using a free stock photo for scene ${i + 1}/${script.scenes.length}`;
        const buffer = await pexels.searchPhoto(scene.stockQuery || scene.imagePrompt, orientation);
        fs.writeFileSync(imagePath, buffer);
      }
    }
    scenes.push({ imagePath, narration: scene.narration });
  }

  job.status = 'narration';
  for (let i = 0; i < scenes.length; i++) {
    job.progress = `recording narration ${i + 1}/${scenes.length}`;
    const { path: narrationPath, duration } = await tts.synthesize(scenes[i].narration, langCode, workDir);
    scenes[i].narrationPath = narrationPath;
    scenes[i].duration = Math.max(1.5, duration);
    scenes[i].captionText = captionsOn ? scenes[i].narration : null;
    scenes[i].lang = langCode;
  }

  job.status = 'rendering';
  const outPath = path.join(OUTPUT_DIR, `video-${job.id}.mp4`);
  await renderVideo({
    scenes,
    orientation,
    addMusic,
    fastMode,
    workDir,
    outPath,
    onProgress: (msg) => {
      job.progress = msg;
    },
  });

  fs.rm(workDir, { recursive: true, force: true }, () => {});
  job.resultPath = outPath;
  job.status = 'done';
  job.progress = 'done';
}

// ---------------------------------------------------------------------------
// Shared job polling / download
// ---------------------------------------------------------------------------
app.get('/api/jobs/:id/status', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (it may have expired).' });
  res.json({ status: job.status, progress: job.progress, error: job.error, title: job.title, ready: job.status === 'done' });
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.resultPath) {
    return res.status(404).json({ error: 'Video not ready yet.' });
  }
  res.download(job.resultPath, `${(job.title || 'ai-video').replace(/[^\w\- ]/g, '').trim() || 'ai-video'}.mp4`);
});

app.listen(PORT, () => console.log(`Free AI Video Creator running on http://localhost:${PORT}`));
