// Free narration: Google Translate's public TTS endpoint (no API key). It only
// accepts short chunks of text per request, so we split on sentence/word
// boundaries and concatenate the resulting MP3 chunks with ffmpeg.

import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import ffmpeg from './ffmpegSetup.js';

const MAX_CHUNK = 190;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function chunkText(text) {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const chunks = [];
  let cur = '';
  for (const sentence of sentences) {
    const piece = sentence.length > MAX_CHUNK ? sentence.match(/.{1,180}(\s|$)/g) || [sentence] : [sentence];
    for (const part of piece) {
      if ((cur + ' ' + part).trim().length > MAX_CHUNK) {
        if (cur) chunks.push(cur.trim());
        cur = part;
      } else {
        cur = (cur + ' ' + part).trim();
      }
    }
  }
  if (cur) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

async function fetchChunk(text, lang) {
  const url =
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}` +
    `&q=${encodeURIComponent(text)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://translate.google.com/' } });
  if (!r.ok) {
    const e = new Error(`Free narration service failed (${r.status}). Try again shortly.`);
    e.code = 'TTS_FAILED';
    throw e;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 200) {
    const e = new Error('Free narration service returned no audio. Try again shortly.');
    e.code = 'TTS_FAILED';
    throw e;
  }
  return buf;
}

function concatMp3(files, outPath) {
  return new Promise((resolve, reject) => {
    const listFile = outPath + '.txt';
    fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .save(outPath)
      .on('end', () => {
        fs.unlinkSync(listFile);
        resolve();
      })
      .on('error', (err) => {
        fs.unlinkSync(listFile);
        reject(err);
      });
  });
}

export function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data?.format?.duration || 0);
    });
  });
}

// Synthesizes `text` to a single MP3 at outPath. Returns { path, duration }.
export async function synthesize(text, lang, outDir) {
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('No narration text to synthesize.');
  const tmpFiles = [];
  try {
    for (const chunk of chunks) {
      const buf = await fetchChunk(chunk, lang);
      const p = path.join(outDir, `tts-${nanoid(8)}.mp3`);
      fs.writeFileSync(p, buf);
      tmpFiles.push(p);
    }
    const outPath = path.join(outDir, `narration-${nanoid(8)}.mp3`);
    if (tmpFiles.length === 1) {
      fs.copyFileSync(tmpFiles[0], outPath);
    } else {
      await concatMp3(tmpFiles, outPath);
    }
    const duration = await probeDuration(outPath);
    return { path: outPath, duration };
  } finally {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}
