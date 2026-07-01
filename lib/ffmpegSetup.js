// Wires fluent-ffmpeg to the statically-bundled ffmpeg/ffprobe binaries so no
// system install is needed (works on Render's free tier out of the box).
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

export default ffmpeg;
export { ffmpegPath };
