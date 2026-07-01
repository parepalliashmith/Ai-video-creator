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
  const content =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,${fontFamily},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,20,20,${marginV},1\n\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    `Dialogue: 0,${assTimestamp(start)},${assTimestamp(end)},Default,,0,0,0,,${assEscapeText(text)}\n`;
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

async function renderSceneClip({ imagePath, narrationPath, duration, captionText, lang }, index, orientation, workDir) {
  const dims = DIMS[orientation];
  const w2 = dims.w * 2;
  const h2 = dims.h * 2;
  const fps = 25;
  const frames = Math.max(1, Math.round(duration * fps));
  const zoomTarget = (1.15 + (index % 3) * 0.05).toFixed(3);

  const filters = [
    `scale=${w2}:${h2}:force_original_aspect_ratio=increase`,
    `crop=${w2}:${h2}`,
    `zoompan=z='min(zoom+0.0015,${zoomTarget})':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${dims.w}x${dims.h}:fps=${fps}`,
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
    const assFile = path.join(workDir, `caption-${index}.ass`);
    writeAssFile(assFile, {
      width: dims.w,
      height: dims.h,
      fontFamily: FONT_FAMILIES[lang] || FONT_FAMILIES.en,
      fontSize: Math.round(dims.h * 0.045),
      marginV: Math.round(dims.h * 0.07),
      start: 0,
      end: duration,
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
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
    ])
    .output(outPath);
  await run(cmd);
  return outPath;
}

function concatClips(clipPaths, workDir, outPath) {
  const listFile = path.join(workDir, `concat-${nanoid(6)}.txt`);
  fs.writeFileSync(
    listFile,
    clipPaths.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
  );
  return run(
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .output(outPath)
  ).finally(() => fs.unlinkSync(listFile));
}

// A soft, license-free ambient pad (three detuned sine tones, low-passed,
// faded in/out) so users get optional background music with zero copyright risk.
function generateMusicBed(duration, outPath) {
  const t = Math.max(1, duration);
  const fadeOutStart = Math.max(0, t - 2);
  const freqs = [220, 277.18, 329.63];
  const cmd = ffmpeg();
  freqs.forEach((f) => cmd.input(`sine=frequency=${f}:duration=${t}`).inputOptions(['-f lavfi']));
  cmd
    .complexFilter([
      `[0:a][1:a][2:a]amix=inputs=3:duration=first,volume=2.5,lowpass=f=900,` +
        `afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart}:d=2[aout]`,
    ])
    .outputOptions(['-map', '[aout]', '-c:a', 'aac', '-b:a', '96k'])
    .output(outPath);
  return run(cmd);
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
  const clipPaths = [];
  for (let i = 0; i < scenes.length; i++) {
    onProgress?.(`rendering scene ${i + 1}/${scenes.length}`);
    clipPaths.push(await renderSceneClip(scenes[i], i, orientation, workDir));
  }

  onProgress?.('combining scenes');
  const concatenated = path.join(workDir, `concat-${nanoid(6)}.mp4`);
  await concatClips(clipPaths, workDir, concatenated);

  if (!addMusic) {
    fs.copyFileSync(concatenated, outPath);
    return outPath;
  }

  onProgress?.('adding background music');
  const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
  const musicPath = path.join(workDir, `music-${nanoid(6)}.aac`);
  await generateMusicBed(totalDuration, musicPath);
  await mixMusic(concatenated, musicPath, outPath);
  return outPath;
}
