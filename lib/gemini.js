// Free Google Gemini calls: script writing (text) + per-scene image generation.
// Supports several comma-separated free keys and a model fallback chain so a
// single quota limit doesn't stop the whole app — same pattern as the user's
// other free-tier tools (ScanQuiz/AIQUIZ, ChatApp's Ghibli art).

const GEMINI_KEYS = (process.env.GEMINI_API_KEY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TEXT_MODEL_CHAIN = [
  process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
].filter((m, i, a) => m && a.indexOf(m) === i);

const IMAGE_MODEL = 'gemini-2.5-flash-image';

export const isConfigured = () => GEMINI_KEYS.length > 0;

function isRetryable(status, msg) {
  return (
    status === 429 ||
    status === 503 ||
    /quota|rate limit|resource has been exhausted|high demand|overloaded|unavailable/i.test(
      msg || ''
    )
  );
}

async function callGemini(model, key, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `Gemini failed (${r.status})`;
    if (isRetryable(r.status, msg)) {
      const e = new Error('The free AI is busy or its daily limit was reached. Please try again in a minute.');
      e.code = 'AI_LIMIT';
      throw e;
    }
    throw new Error(msg);
  }
  return data;
}

// Pull the first JSON object out of the model's text response.
function parseJson(text) {
  if (!text) throw new Error('Empty response from model.');
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Model did not return JSON.');
  return JSON.parse(s.slice(start, end + 1));
}

function buildScriptPrompt(topic, sceneCount, orientation, languageName) {
  return (
    `You are a scriptwriter for short AI-narrated videos. Write a script about: "${topic}".\n\n` +
    `Break it into exactly ${sceneCount} scenes. Each scene needs:\n` +
    `- "narration": 1-2 spoken sentences (natural, engaging, no stage directions), written in ${languageName}\n` +
    `- "imagePrompt": a vivid visual description IN ENGLISH for an AI image generator to illustrate this ` +
    `scene (describe subject, setting, mood, lighting, style — no text/words in the image). ` +
    `The image will be framed in ${orientation === 'portrait' ? 'a tall 9:16 portrait' : 'a wide 16:9 landscape'} shape.\n` +
    `- "stockQuery": a short literal 2-4 word English search phrase for a stock-photo search engine that would ` +
    `find a REAL photo reasonably close to this scene (used only as a fallback if AI image generation is unavailable).\n\n` +
    `Respond with STRICT JSON only (no markdown, no code fences):\n` +
    `{ "title": "short catchy title", "scenes": [ { "narration": "...", "imagePrompt": "...", "stockQuery": "..." } ] }`
  );
}

// Try every key × model combination; only a quota/overload error advances.
export async function generateScript(topic, sceneCount, orientation, languageName = 'English') {
  if (!isConfigured()) {
    const e = new Error('Video AI is not configured yet — set GEMINI_API_KEY on the server.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const body = {
    contents: [{ parts: [{ text: buildScriptPrompt(topic, sceneCount, orientation, languageName) }] }],
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json' },
  };
  let lastErr;
  for (const key of GEMINI_KEYS) {
    for (const model of TEXT_MODEL_CHAIN) {
      try {
        const data = await callGemini(model, key, body);
        const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        const parsed = parseJson(text);
        if (!Array.isArray(parsed.scenes) || !parsed.scenes.length) {
          throw new Error('Model did not return any scenes.');
        }
        return parsed;
      } catch (e) {
        lastErr = e;
        if (e.code !== 'AI_LIMIT') throw e;
      }
    }
  }
  throw lastErr;
}

// Generate one image for a scene. Rotates across keys on quota/overload.
export async function generateImage(prompt, orientation) {
  if (!isConfigured()) {
    const e = new Error('Video AI is not configured yet — set GEMINI_API_KEY on the server.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const shape = orientation === 'portrait' ? 'vertical 9:16 portrait' : 'horizontal 16:9 landscape';
  const body = {
    contents: [
      {
        parts: [
          {
            text:
              `${prompt}\n\nGenerate this as a single ${shape} image. Rich detail, cinematic ` +
              `lighting, no text or watermarks in the image.`,
          },
        ],
      },
    ],
  };
  let lastErr;
  for (const key of GEMINI_KEYS) {
    try {
      const data = await callGemini(IMAGE_MODEL, key, body);
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const inline = parts.find((p) => p.inlineData || p.inline_data)?.inlineData
        || parts.find((p) => p.inlineData || p.inline_data)?.inline_data;
      if (!inline) throw new Error('Gemini did not return an image.');
      return { buffer: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType || inline.mime_type || 'image/png' };
    } catch (e) {
      lastErr = e;
      if (e.code !== 'AI_LIMIT') throw e;
    }
  }
  throw lastErr;
}
