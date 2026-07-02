// Assembles scenes (image + narration audio + caption) into one MP4 using
// ffmpeg: Ken Burns pan/zoom per scene, burned-in captions, concatenation,
// and an optional procedurally-generated ambient music bed (no copyrighted
// assets needed — just a few detuned sine waves, low-passed and faded).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import ffmpeg from './ffmpegSetup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
// Family names as embedded in each ttf's 'name' table — passed to libass via
// force_style so it doesn't depend on system fontconfig registration.
const FONT_FAMILIES = {
  en: 'Noto Sans',
  te: 'Noto Sans Telugu',
  hi: 'Noto Sans Devanagari',
};

const DIMS = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
};

// Escapes a filesystem path for safe use inside an ffmpeg filter option value
// (colons — e.g. a Windows drive letter — and backslashes need escaping).
function escFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function assTimestamp(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = String(Math.floor((cs % 360000) / 6000)).padStart(2, '0');
  const s = String(Math.floor((cs % 6000) / 100)).padStart(2, '0');
  const c = String(cs % 100).padStart(2, '0');
  return `${h}:${m}:${s}.${c}`;
}

function assEscapeText(text) {
  return text.replace(/\\/g, '/').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
}

// Writes a self-contained .ass subtitle with the style (font/size/colors)
// embedded in the file itself, so the ffmpeg CLI filter string only ever
// needs a bare `subtitles=filename=...:fontsdir=...` — no font-family names
// (which contain spaces, e.g. "Noto Sans") ever appear as a CLI argument.
function writeAssFile(assPath, { width, height, fontFamily, fontSize, marginV, start, end, text }) {
  // \fad(in,out) gives the caption a soft fade instead of popping in/out abruptly.
  const content =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,${fontFamily},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,20,20,${marginV},1\n\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    `Dialogue: 0,${assTimestamp(start)},${assTimestamp(end)},Default,,0,0,0,,{\\fad(300,200)}${assEscapeText(text)}\n`;
  fs.writeFileSync(assPath, content);
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    cmd
      .on('error', (err, stdout, stderr) => {
        if (stderr) err.message += `\n--- ffmpeg stderr (tail) ---\n${stderr.split('\n').slice(-25).join('\n')}`;
        reject(err);
      })
      .on('end', resolve)
      .run();
  });
}

// Shared by scene-caption timing and xfadeConcat so both agree on exactly
// how long each crossfade between scene i-1/i lasts.
function transitionDuration(durA, durB) {
  return Math.max(0.15, Math.min(0.5, durA * 0.4, durB * 0.4));
}

async function renderSceneClip({ imagePath, narrationPath, duration, captionText, lang, dIn = 0, dOut = 0 }, index, orientation, workDir) {
  const dims = DIMS[orientation];
  // Oversample by 1.5x (not more) before zoompan so the zoom-in effect stays
  // sharp — kept modest to limit peak memory on small free-tier instances.
  const w2 = Math.round(dims.w * 1.5);
  const h2 = Math.round(dims.h * 1.5);
  const fps = 25;
  const frames = Math.max(1, Math.round(duration * fps));
  const zoomTarget = (1.12 + (index % 3) * 0.04).toFixed(3);
  // Cycle the pan anchor per scene (instead of always zooming toward dead
  // center) so consecutive scenes feel less repetitive.
  const PAN_TARGETS = [
    [0.5, 0.5],
    [0.4, 0.35],
    [0.6, 0.58],
  ];
  const [tx, ty] = PAN_TARGETS[index % PAN_TARGETS.length];

  const filters = [
    // Cap the source image's largest side first — stock/AI photos can arrive
    // much larger than we need, and decoding+scaling them at full size is the
    // single biggest memory cost in this pipeline (OOM'd a 512MB instance).
    `scale=1600:1600:force_original_aspect_ratio=decrease`,
    `scale=${w2}:${h2}:force_original_aspect_ratio=increase`,
    `crop=${w2}:${h2}`,
    `zoompan=z='min(zoom+0.0015,${zoomTarget})':d=${frames}:x='${tx}*(iw-iw/zoom)':y='${ty}*(ih-ih/zoom)':s=${dims.w}x${dims.h}:fps=${fps}`,
    'format=yuv420p',
  ];

  if (captionText && captionText.trim()) {
    // Burn in via the `subtitles` (libass) filter rather than `drawtext` —
    // some static ffmpeg builds (e.g. Render's Linux runtime) ship libass but
    // omit the drawtext filter entirely. All styling (font family/size/color)
    // lives inside the .ass file itself, so the ffmpeg CLI filter string stays
    // a bare `subtitles=filename=...:fontsdir=...` with no embedded spaces —
    // font family names like "Noto Sans" broke argument parsing when passed
    // via `force_style` on the CLI on Render's Linux runtime.
    // Keep the caption fully clear of the crossfade windows at either end —
    // otherwise this scene's outgoing text and the next scene's incoming
    // text burn in on top of each other into an unreadable jumble.
    const capStart = dIn;
    const capEnd = Math.max(capStart + 0.3, duration - dOut);
    const assFile = path.join(workDir, `caption-${index}.ass`);
    writeAssFile(assFile, {
      width: dims.w,
      height: dims.h,
      fontFamily: FONT_FAMILIES[lang] || FONT_FAMILIES.en,
      fontSize: Math.round(dims.h * 0.045),
      marginV: Math.round(dims.h * 0.07),
      start: capStart,
      end: capEnd,
      text: captionText.trim(),
    });
    filters.push(`subtitles=filename='${escFilterPath(assFile)}':fontsdir='${escFilterPath(FONTS_DIR)}'`);
  }

  const outPath = path.join(workDir, `scene-${index}.mp4`);
  const cmd = ffmpeg()
    .input(imagePath)
    .inputOptions(['-loop 1'])
    .input(narrationPath)
    .outputOptions([
      '-vf', filters.join(','),
      '-t', String(duration),
      '-r', String(fps),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-threads', '1',
      '-filter_threads', '1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
    ])
    .output(outPath);
  await run(cmd);
  return outPath;
}

// Joins scene clips with short crossfades (video: xfade, audio: acrossfade)
// instead of hard cuts — a lot closer to how real edited video feels. Runs on
// already-final-resolution clips (post-zoompan), so it's cheap relative to
// the per-scene rendering pass.
function xfadeConcat(clipPaths, durations, outPath) {
  const n = clipPaths.length;
  if (n === 1) {
    return run(ffmpeg().input(clipPaths[0]).outputOptions(['-c', 'copy']).output(outPath));
  }

  const cmd = ffmpeg();
  clipPaths.forEach((p) => cmd.input(p));

  const filterLines = [];
  let vCur = '0:v';
  let aCur = '0:a';
  let cumLen = durations[0];
  for (let i = 1; i < n; i++) {
    const d = Math.max(0.15, Math.min(0.5, durations[i - 1] * 0.4, durations[i] * 0.4));
    const offset = Math.max(0, cumLen - d);
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    filterLines.push(`[${vCur}][${i}:v]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`);
    filterLines.push(`[${aCur}][${i}:a]acrossfade=d=${d.toFixed(3)}[${aOut}]`);
    vCur = vOut;
    aCur = aOut;
    cumLen = cumLen + durations[i] - d;
  }
  filterLines.push(`[${vCur}]fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(0, cumLen - 0.4).toFixed(3)}:d=0.4[vout]`);

  cmd
    .complexFilter(filterLines)
    .outputOptions([
      '-map', '[vout]',
      '-map', `[${aCur}]`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-threads', '1',
      '-filter_threads', '1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
    ])
    .output(outPath);
  return run(cmd);
}

// A soft, license-free ambient pad (three detuned sine tones, faded in/out),
// synthesized directly as a WAV file in plain JS — this static ffmpeg build
// doesn't compile in the `lavfi` virtual input, so tone generation can't go
// through ffmpeg at all here.
function writeWavSineBed(outPath, duration) {
  const sampleRate = 44100;
  const freqs = [220, 277.18, 329.63];
  const numSamples = Math.max(1, Math.round(duration * sampleRate));
  const fadeSamples = Math.min(numSamples, sampleRate * 2);
  const data = Buffer.alloc(numSamples * 2); // 16-bit mono PCM

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const f of freqs) sample += Math.sin(2 * Math.PI * f * t);
    sample /= freqs.length; // average -> range [-1, 1]

    let envelope = 1;
    if (i < fadeSamples) envelope = i / fadeSamples;
    else if (i > numSamples - fadeSamples) envelope = (numSamples - i) / fadeSamples;

    const amplitude = 0.25; // quiet pad; final mix attenuates further anyway
    const value = Math.max(-1, Math.min(1, sample * envelope * amplitude));
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  fs.writeFileSync(outPath, Buffer.concat([header, data]));
}

function generateMusicBed(duration, outPath) {
  writeWavSineBed(outPath, Math.max(1, duration));
  return Promise.resolve();
}

function mixMusic(videoPath, musicPath, outPath) {
  const cmd = ffmpeg()
    .input(videoPath)
    .input(musicPath)
    .complexFilter([
      '[0:a]volume=1[a0]',
      '[1:a]volume=0.16[a1]',
      '[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]',
    ])
    .outputOptions(['-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest'])
    .output(outPath);
  return run(cmd);
}

// scenes: [{ imagePath, narrationPath, duration, captionText }]
export async function renderVideo({ scenes, orientation, addMusic, workDir, outPath, onProgress }) {
  fs.mkdirSync(workDir, { recursive: true });
  const durations = scenes.map((s) => s.duration);
  const clipPaths = [];
  for (let i = 0; i < scenes.length; i++) {
    onProgress?.(`rendering scene ${i + 1}/${scenes.length}`);
    const dIn = i > 0 ? transitionDuration(durations[i - 1], durations[i]) : 0;
    const dOut = i < scenes.length - 1 ? transitionDuration(durations[i], durations[i + 1]) : 0;
    clipPaths.push(await renderSceneClip({ ...scenes[i], dIn, dOut }, i, orientation, workDir));
  }

  onProgress?.('combining scenes');
  const concatenated = path.join(workDir, `concat-${nanoid(6)}.mp4`);
  await xfadeConcat(clipPaths, scenes.map((s) => s.duration), concatenated);

  if (!addMusic) {
    fs.copyFileSync(concatenated, outPath);
    return outPath;
  }

  onProgress?.('adding background music');
  const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
  const musicPath = path.join(workDir, `music-${nanoid(6)}.wav`);
  await generateMusicBed(totalDuration, musicPath);
  await mixMusic(concatenated, musicPath, outPath);
  return outPath;
}
