// Free stock-photo fallback (Pexels API, no billing/card required) for when
// Gemini's free-tier image generation quota is unavailable. Not "AI art", but
// keeps Mode A fully free and working end-to-end.

const PEXELS_KEY = process.env.PEXELS_API_KEY || '';

export const isConfigured = () => !!PEXELS_KEY;

export async function searchPhoto(query, orientation) {
  if (!isConfigured()) {
    const e = new Error('Stock-photo fallback is not configured (set PEXELS_API_KEY).');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const params = new URLSearchParams({
    query,
    orientation: orientation === 'portrait' ? 'portrait' : 'landscape',
    per_page: '1',
  });
  const r = await fetch(`https://api.pexels.com/v1/search?${params}`, {
    headers: { Authorization: PEXELS_KEY },
  });
  if (!r.ok) {
    const e = new Error(`Stock-photo search failed (${r.status}).`);
    e.code = 'ERROR';
    throw e;
  }
  const data = await r.json();
  const photo = data?.photos?.[0];
  if (!photo) {
    const e = new Error(`No stock photo found for "${query}".`);
    e.code = 'NOT_FOUND';
    throw e;
  }
  const src = orientation === 'portrait' ? photo.src.portrait || photo.src.large2x : photo.src.landscape || photo.src.large2x;
  const imgRes = await fetch(src);
  if (!imgRes.ok) throw new Error(`Could not download stock photo (${imgRes.status}).`);
  return Buffer.from(await imgRes.arrayBuffer());
}
