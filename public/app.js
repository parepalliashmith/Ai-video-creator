// Free AI Video Creator — frontend: tabs, forms, job polling, result playback.

const $ = (sel) => document.querySelector(sel);

// ---------------- Tabs ----------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const tab = btn.dataset.tab;
    $('#panel-scene').hidden = tab !== 'scene';
    $('#panel-clip').hidden = tab !== 'clip';
  });
});

// ---------------- Segmented controls ----------------
let orientation = 'landscape';
document.querySelectorAll('[data-orientation]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-orientation]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    orientation = btn.dataset.orientation;
  });
});

let imageSource = 'ai';
document.querySelectorAll('[data-imgsrc]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-imgsrc]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    imageSource = btn.dataset.imgsrc;
    $('#upload-field').hidden = imageSource !== 'upload';
  });
});

// ---------------- Health check ----------------
fetch('/api/health')
  .then((r) => r.json())
  .then((health) => {
    if (!health.geminiConfigured) {
      $('#scene-submit').disabled = true;
      $('#scene-config-hint').textContent =
        'Video AI is not configured yet — the server needs a free GEMINI_API_KEY.';
    } else if (!health.stockPhotoConfigured) {
      $('#scene-config-hint').textContent =
        'Tip: AI-generated images can hit free-tier limits — add a free PEXELS_API_KEY on the server for an automatic stock-photo fallback, or use "Upload my photos".';
    }
  })
  .catch(() => {});

fetch('/api/clip/status')
  .then((r) => r.json())
  .then((s) => {
    if (!s.enabled) {
      $('#clip-submit').disabled = true;
      $('#clip-config-hint').textContent =
        'Not enabled — add a free Hugging Face token (HUGGINGFACE_API_KEY) on the server to try this experimental mode.';
    }
  })
  .catch(() => {});

// ---------------- Shared job polling ----------------
function pollJob(jobId, { statusEl, textEl, onDone, onError }) {
  const tick = async () => {
    try {
      const r = await fetch(`/api/jobs/${jobId}/status`);
      if (!r.ok) throw new Error((await r.json()).error || 'Job not found.');
      const data = await r.json();
      if (data.error) return onError(data.error);
      if (textEl) textEl.textContent = describeProgress(data.status, data.progress);
      if (data.ready) return onDone(data);
      setTimeout(tick, 1800);
    } catch (e) {
      onError(e.message);
    }
  };
  tick();
}

function describeProgress(status, progress) {
  const labels = {
    queued: 'Queued…',
    script: 'Writing the script…',
    images: 'Generating scene images…',
    narration: 'Recording narration…',
    rendering: 'Rendering your video…',
    generating: 'Generating…',
    done: 'Done!',
  };
  const base = labels[status] || 'Working…';
  return progress && progress !== status ? `${base} (${progress})` : base;
}

// ---------------- Mode A: Scene Video ----------------
const sceneForm = $('#scene-form');
const sceneStatus = $('#scene-status');
const sceneStatusText = $('#scene-status-text');
const sceneError = $('#scene-error');
const sceneResult = $('#scene-result');

function resetSceneUI() {
  sceneForm.hidden = false;
  sceneStatus.hidden = true;
  sceneError.hidden = true;
  sceneResult.hidden = true;
}

sceneForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const topic = $('#topic').value.trim();
  if (!topic) return;

  const fd = new FormData();
  fd.append('topic', topic);
  fd.append('sceneCount', $('#sceneCount').value);
  fd.append('lang', $('#lang').value);
  fd.append('orientation', orientation);
  fd.append('imageSource', imageSource);
  fd.append('captionsOn', $('#captionsOn').checked);
  fd.append('addMusic', $('#addMusic').checked);
  if (imageSource === 'upload') {
    const files = $('#images').files;
    for (const f of files) fd.append('images', f);
  }

  sceneForm.hidden = true;
  sceneError.hidden = true;
  sceneResult.hidden = true;
  sceneStatus.hidden = false;
  sceneStatusText.textContent = 'Starting…';

  try {
    const r = await fetch('/api/video', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not start the job.');
    pollJob(data.jobId, {
      textEl: sceneStatusText,
      onDone: async (job) => {
        sceneStatus.hidden = true;
        sceneResult.hidden = false;
        $('#scene-result-title').textContent = job.title || 'Your video';
        const fileUrl = `/api/jobs/${data.jobId}/file`;
        $('#scene-video').src = fileUrl;
        $('#scene-download').href = fileUrl;
      },
      onError: (msg) => {
        sceneStatus.hidden = true;
        sceneError.hidden = false;
        $('#scene-error-text').textContent = msg;
      },
    });
  } catch (err) {
    sceneStatus.hidden = true;
    sceneError.hidden = false;
    $('#scene-error-text').textContent = err.message;
  }
});

$('#scene-retry').addEventListener('click', resetSceneUI);
$('#scene-again').addEventListener('click', resetSceneUI);

// ---------------- Mode B: Experimental AI Clip ----------------
const clipForm = $('#clip-form');
const clipStatus = $('#clip-status');
const clipStatusText = $('#clip-status-text');
const clipError = $('#clip-error');
const clipResult = $('#clip-result');

function resetClipUI() {
  clipForm.hidden = false;
  clipStatus.hidden = true;
  clipError.hidden = true;
  clipResult.hidden = true;
}

clipForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('#clip-prompt').value.trim();
  if (!prompt) return;

  clipForm.hidden = true;
  clipError.hidden = true;
  clipResult.hidden = true;
  clipStatus.hidden = false;
  clipStatusText.textContent = 'Starting…';

  try {
    const r = await fetch('/api/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not start the job.');
    pollJob(data.jobId, {
      textEl: clipStatusText,
      onDone: (job) => {
        clipStatus.hidden = true;
        clipResult.hidden = false;
        const fileUrl = `/api/jobs/${data.jobId}/file`;
        $('#clip-video').src = fileUrl;
        $('#clip-download').href = fileUrl;
      },
      onError: (msg) => {
        clipStatus.hidden = true;
        clipError.hidden = false;
        $('#clip-error-text').textContent = msg;
      },
    });
  } catch (err) {
    clipStatus.hidden = true;
    clipError.hidden = false;
    $('#clip-error-text').textContent = err.message;
  }
});

$('#clip-retry').addEventListener('click', resetClipUI);
$('#clip-again').addEventListener('click', resetClipUI);
