// Free AI Video Creator — frontend: form, job polling, result playback.

const $ = (sel) => document.querySelector(sel);

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

// Quick = fast render (hard cuts); Smooth = crossfade transitions.
let fastMode = true;
document.querySelectorAll('[data-speed]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-speed]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    fastMode = btn.dataset.speed === 'quick';
  });
});

// ---------------- Example topic chips ----------------
document.querySelectorAll('#topic-chips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $('#topic').value = chip.dataset.topic;
    $('#topic').focus();
  });
});

// ---------------- Music mood (only relevant if music is on) ----------------
$('#addMusic').addEventListener('change', () => {
  $('#mood-field').hidden = !$('#addMusic').checked;
});

// ---------------- Health check ----------------
fetch('/api/health')
  .then((r) => r.json())
  .then((health) => {
    if (!health.geminiConfigured) {
      $('#scene-submit').disabled = true;
      $('#scene-config-hint').textContent =
        'This site is still being set up (missing a free API key) — please check back soon.';
    } else if (!health.stockPhotoConfigured) {
      $('#scene-config-hint').textContent =
        "Tip: if AI picture generation is busy, switch to \"Use my own photos\" for an instant alternative.";
    }
  })
  .catch(() => {});

// ---------------- Job polling with a step checklist ----------------
const STEP_ORDER = ['script', 'images', 'narration', 'rendering'];

function updateSteps(status) {
  const currentIndex = STEP_ORDER.indexOf(status);
  document.querySelectorAll('#scene-steps li').forEach((li) => {
    const stepIndex = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.remove('step-done', 'step-active');
    if (status === 'done' || (currentIndex !== -1 && stepIndex < currentIndex)) {
      li.classList.add('step-done');
    } else if (stepIndex === currentIndex) {
      li.classList.add('step-active');
    }
  });
}

function pollJob(jobId, { onProgress, onDone, onError }) {
  const tick = async () => {
    try {
      const r = await fetch(`/api/jobs/${jobId}/status`);
      if (!r.ok) throw new Error((await r.json()).error || "Couldn't find that job — please try again.");
      const data = await r.json();
      if (data.error) return onError(data.error);
      onProgress?.(data.status, data.progress);
      if (data.ready) return onDone(data);
      setTimeout(tick, 1800);
    } catch (e) {
      onError(e.message);
    }
  };
  tick();
}

// ---------------- Recent videos (client-side history, localStorage only) ----------------
const RECENT_KEY = 'aivc_recent_videos';
const MAX_RECENT = 5;

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRecent(list) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
}

function addRecent(entry) {
  const list = loadRecent();
  list.unshift(entry);
  saveRecent(list);
  renderRecentList();
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fillFormFromSettings(s) {
  $('#topic').value = s.topic || '';
  $('#sceneCount').value = s.sceneCount;
  $('#lang').value = s.lang;
  $('#captionsOn').checked = s.captionsOn;
  $('#addMusic').checked = s.addMusic;
  $('#musicMood').value = s.musicMood || 'calm';
  $('#mood-field').hidden = !s.addMusic;

  orientation = s.orientation;
  document.querySelectorAll('[data-orientation]').forEach((b) => b.classList.toggle('active', b.dataset.orientation === orientation));
  fastMode = s.fastMode;
  document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', (b.dataset.speed === 'quick') === fastMode));
  // Uploaded photos can't be restored — recreate with AI images instead.
  imageSource = 'ai';
  document.querySelectorAll('[data-imgsrc]').forEach((b) => b.classList.toggle('active', b.dataset.imgsrc === 'ai'));
  $('#upload-field').hidden = true;
}

function renderRecentList() {
  const list = loadRecent();
  const section = $('#recent-section');
  const ul = $('#recent-list');
  section.hidden = list.length === 0;
  ul.innerHTML = '';
  list.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'recent-item';
    li.innerHTML = `
      <div class="recent-info">
        <strong>${entry.title || entry.topic}</strong>
        <span class="recent-time">${timeAgo(entry.createdAt)}</span>
      </div>
      <div class="recent-actions">
        <a href="/api/jobs/${entry.jobId}/file" class="recent-link" download>⬇ Download</a>
        <button type="button" class="recent-link recent-again">🔁 Make again</button>
      </div>`;
    li.querySelector('.recent-again').addEventListener('click', () => {
      fillFormFromSettings(entry);
      sceneForm.scrollIntoView({ behavior: 'smooth' });
    });
    ul.appendChild(li);
  });
}

renderRecentList();

// ---------------- Scene Video form ----------------
const sceneForm = $('#scene-form');
const sceneStatus = $('#scene-status');
const sceneStatusSub = $('#scene-status-sub');
const sceneError = $('#scene-error');
const sceneResult = $('#scene-result');

let elapsedTimer = null;
function startElapsedTimer() {
  const start = Date.now();
  elapsedTimer = setInterval(() => {
    const secs = Math.round((Date.now() - start) / 1000);
    sceneStatusSub.textContent = `Still working… ${secs}s elapsed. Thanks for your patience!`;
  }, 1000);
}
function stopElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function resetSceneUI() {
  sceneForm.hidden = false;
  sceneStatus.hidden = true;
  sceneError.hidden = true;
  sceneResult.hidden = true;
  stopElapsedTimer();
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
  fd.append('musicMood', $('#musicMood').value);
  fd.append('fastMode', fastMode);
  if (imageSource === 'upload') {
    const files = $('#images').files;
    for (const f of files) fd.append('images', f);
  }

  const settingsSnapshot = {
    topic,
    sceneCount: $('#sceneCount').value,
    lang: $('#lang').value,
    orientation,
    captionsOn: $('#captionsOn').checked,
    addMusic: $('#addMusic').checked,
    musicMood: $('#musicMood').value,
    fastMode,
  };

  sceneForm.hidden = true;
  sceneError.hidden = true;
  sceneResult.hidden = true;
  sceneStatus.hidden = false;
  updateSteps('script');
  sceneStatusSub.textContent = 'This usually takes a couple of minutes — feel free to wait here.';
  startElapsedTimer();

  try {
    const r = await fetch('/api/video', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not start the video. Please try again.');
    pollJob(data.jobId, {
      onProgress: (status) => updateSteps(status),
      onDone: async (job) => {
        stopElapsedTimer();
        sceneStatus.hidden = true;
        sceneResult.hidden = false;
        $('#scene-result-title').textContent = job.title ? `🎉 "${job.title}" is ready!` : '🎉 Your video is ready!';
        const fileUrl = `/api/jobs/${data.jobId}/file`;
        $('#scene-video').src = fileUrl;
        $('#scene-download').href = fileUrl;
        addRecent({ ...settingsSnapshot, jobId: data.jobId, title: job.title, createdAt: Date.now() });
      },
      onError: (msg) => {
        stopElapsedTimer();
        sceneStatus.hidden = true;
        sceneError.hidden = false;
        $('#scene-error-text').textContent = msg;
      },
    });
  } catch (err) {
    stopElapsedTimer();
    sceneStatus.hidden = true;
    sceneError.hidden = false;
    $('#scene-error-text').textContent = err.message;
  }
});

$('#scene-retry').addEventListener('click', resetSceneUI);
$('#scene-again').addEventListener('click', resetSceneUI);
