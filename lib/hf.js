// Experimental, best-effort true text-to-video via Hugging Face's free
// serverless Inference API. Free hosted text-to-video is genuinely unreliable
// (small models, cold-start "loading" states, some models not served on the
// free tier at all) — this module surfaces clear error codes so the UI can
// set honest expectations instead of pretending this is as solid as Mode A.

const HF_TOKEN = process.env.HUGGINGFACE_API_KEY || '';
const MODEL = process.env.HF_TEXT_TO_VIDEO_MODEL || 'damo-vilab/text-to-video-ms-1.7b';

export const isConfigured = () => !!HF_TOKEN;

export async function generateClip(prompt) {
  if (!isConfigured()) {
    const e = new Error('Experimental AI clip is not configured — add a free Hugging Face token (HUGGINGFACE_API_KEY) to enable it.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }

  const r = await fetch(`https://api-inference.huggingface.co/models/${MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: prompt }),
  });

  const contentType = r.headers.get('content-type') || '';

  if (r.ok && /video|octet-stream/i.test(contentType)) {
    return Buffer.from(await r.arrayBuffer());
  }

  let payload;
  try {
    payload = await r.json();
  } catch {
    payload = null;
  }
  const msg = payload?.error || `Hugging Face request failed (${r.status})`;

  if (r.status === 404 || /not supported|not found|no model on the hub/i.test(msg)) {
    const e = new Error('This free AI clip model is unavailable on the free hosted tier right now.');
    e.code = 'UNAVAILABLE';
    throw e;
  }
  if (r.status === 503 || /loading|currently loading/i.test(msg)) {
    const e = new Error(`The free model is still waking up (est. ${Math.ceil(payload?.estimated_time || 20)}s) — try again shortly.`);
    e.code = 'LOADING';
    throw e;
  }
  const e = new Error(msg);
  e.code = 'ERROR';
  throw e;
}
