import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './utils.js';
import type { QuranAyahSegment } from './quran.js';

const ROOT = process.cwd();
const ARABIC_FONT = path.join(ROOT, 'data/fonts/Quran-Arabic-DigitalKhatt.otf');
const ENGLISH_FONT = path.join(ROOT, 'data/fonts/English-Inter-Italic.ttf');
const OVERLAY_SCRIPT = path.join(ROOT, 'scripts/render-quran-overlay.py');

function pythonExecutable() {
  return process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'python' : 'python3');
}

export async function renderQuranVideo(args: {
  sourceVideo: string;
  outputVideo: string;
  duration: number;
  width: number;
  height: number;
  backgroundMode: 'original' | 'black';
  segments: QuranAyahSegment[];
  signal?: AbortSignal;
}) {
  const renderWidth = args.backgroundMode === 'black' ? 1080 : args.width;
  const renderHeight = args.backgroundMode === 'black' ? 1920 : args.height;
  const workDir = path.dirname(args.outputVideo);
  const overlayDir = path.join(workDir, 'quran-overlay');
  const requestPath = path.join(workDir, 'quran-overlay-request.json');
  const overlayVideo = path.join(workDir, 'quran-overlay.mov');
  const temp = args.outputVideo.replace(/\.mp4$/i, '.rendering.mp4');

  await Promise.all([fs.access(ARABIC_FONT), fs.access(ENGLISH_FONT), fs.access(OVERLAY_SCRIPT)]);
  await fs.mkdir(overlayDir, { recursive: true });
  const request = {
    width: renderWidth,
    height: renderHeight,
    duration: args.duration,
    arabicFont: ARABIC_FONT,
    englishFont: ENGLISH_FONT,
    outputDir: overlayDir,
    segments: args.segments.map((segment) => ({
      surah: segment.surah,
      ayah: segment.ayah,
      start: segment.start,
      end: segment.end,
      arabic: segment.arabic,
      english: segment.english,
    })),
  };
  await fs.writeFile(requestPath, JSON.stringify(request), 'utf8');

  const python = pythonExecutable();
  await run(python, [OVERLAY_SCRIPT, requestPath], { timeoutMs: 5 * 60_000, signal: args.signal });
  const concatFile = path.join(overlayDir, 'overlay.ffconcat');
  await fs.access(concatFile);

  // Pillow's RAQM/HarfBuzz renderer shapes the supplied Quran font before FFmpeg
  // composites it. libass does not shape this particular font correctly.
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-an', '-c:v', 'png', '-pix_fmt', 'rgba', '-fps_mode', 'vfr', overlayVideo,
  ], { timeoutMs: 10 * 60_000, signal: args.signal });

  const filter = args.backgroundMode === 'black'
    ? `color=c=black:s=1080x1920:r=30:d=${args.duration}[base];[1:v]format=rgba[ov];[base][ov]overlay=0:0:format=auto:shortest=1,setsar=1,format=yuv420p[outv]`
    : '[0:v]format=yuv420p[base];[1:v]format=rgba[ov];[base][ov]overlay=0:0:format=auto:shortest=1[outv]';

  const ffmpegArgs = [
    '-y', '-hide_banner', '-i', args.sourceVideo, '-i', overlayVideo,
    '-filter_complex', filter,
    '-map', '[outv]', '-map', '0:a:0',
    '-t', String(args.duration), '-r', '30', '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
    '-movflags', '+faststart', '-max_muxing_queue_size', '4096',
    '-map_metadata', '0', '-map_chapters', '-1',
  ];
  ffmpegArgs.push('-metadata:s:v:0', 'rotate=0');
  ffmpegArgs.push(temp);
  await run('ffmpeg', ffmpegArgs, { timeoutMs: 20 * 60_000, signal: args.signal });
  await fs.rename(temp, args.outputVideo);
  await fs.copyFile(path.join(overlayDir, 'layout-report.json'), path.join(workDir, 'layout-report.json')).catch(() => {});
  await fs.rm(overlayDir, { recursive: true, force: true });
  await fs.rm(overlayVideo, { force: true });
  await fs.rm(requestPath, { force: true });
  return { width: renderWidth, height: renderHeight };
}
