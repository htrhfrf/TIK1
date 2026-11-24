import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  AUTH_TOKEN, CLIENT_DIST, HOST, MAX_UPLOAD_MB, MAX_VIDEO_SECONDS, NODE_ENV, PORT,
  PROJECT_DIR, ROOT, UPLOAD_DIR, getGeminiApiKey,
} from './config.js';
import { acquireSource } from './downloader.js';
import { run, safeName } from './utils.js';
import { transcribe } from './gemini.js';
import { identifyAyahsWithGemini, loadQuranIndex, matchTimedTranscript, mergeAyahMatches, type QuranAyahSegment } from './quran.js';
import { renderQuranVideo } from './quran-render.js';
import type { TimedWord } from './types.js';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.use(cors({ origin: true, credentials: true, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '2mb' }));

await Promise.all([
  fs.mkdir(PROJECT_DIR, { recursive: true }),
  fs.mkdir(UPLOAD_DIR, { recursive: true }),
  fs.mkdir(path.join(ROOT, 'data/fonts'), { recursive: true }),
]);
const quranIndex = await loadQuranIndex();

interface ProjectState {
  id: string;
  name: string;
  status: 'queued' | 'processing' | 'complete' | 'error' | 'cancelled';
  stage: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  sourceName: string;
  sourceUrl?: string;
  sourcePath?: string;
  backgroundMode: 'original' | 'black';
  sourceWidth?: number;
  sourceHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  duration?: number;
  transcript?: string;
  recognizedAyahs?: QuranAyahSegment[];
  outputUrl?: string;
  error?: string;
  logs: string[];
}
const queue: string[] = [];
const running = new Set<string>();
const controllers = new Map<string, AbortController>();
const active = new Map<string, ProjectState>();

function projectDir(id: string) { return path.join(PROJECT_DIR, id); }
function projectFile(id: string) { return path.join(projectDir(id), 'project.json'); }
function now() { return new Date().toISOString(); }
function addLog(project: ProjectState, text: string) {
  project.logs = [...(project.logs || []), `[${new Date().toLocaleTimeString()}] ${text}`].slice(-100);
}
async function persist(project: ProjectState) {
  project.updatedAt = now();
  active.set(project.id, project);
  await fs.writeFile(projectFile(project.id), JSON.stringify(project, null, 2), 'utf8');
}
async function readProject(id: string): Promise<ProjectState> {
  if (!/^[a-f0-9]{20,40}$/i.test(id)) throw new Error('Project not found.');
  const cached = active.get(id);
  if (cached) return cached;
  const project = JSON.parse(await fs.readFile(projectFile(id), 'utf8')) as ProjectState;
  active.set(id, project);
  return project;
}
async function listProjects(): Promise<ProjectState[]> {
  const names = await fs.readdir(PROJECT_DIR).catch(() => [] as string[]);
  const projects: ProjectState[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{20,40}$/i.test(name)) continue;
    try { projects.push(await readProject(name)); } catch {}
  }
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function abortCheck(project: ProjectState, signal: AbortSignal) {
  if (signal.aborted || project.status === 'cancelled') throw new Error('Job cancelled.');
}

async function probeVideo(file: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 30_000 });
  const parsed = JSON.parse(stdout) as any;
  const video = parsed.streams?.find((s: any) => s.codec_type === 'video');
  const audio = parsed.streams?.find((s: any) => s.codec_type === 'audio');
  if (!video) throw new Error('The supplied file does not contain a video stream.');
  if (!audio) throw new Error('The supplied video has no audio stream. A Quran recitation audio track is required.');
  const duration = Number(parsed.format?.duration || video.duration || audio.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not read the video duration.');
  if (duration > MAX_VIDEO_SECONDS) throw new Error(`The video is ${duration.toFixed(1)} seconds. The configured maximum is ${MAX_VIDEO_SECONDS} seconds.`);
  let width = Number(video.width || 0);
  let height = Number(video.height || 0);
  const rotation = Number(video.tags?.rotate || video.side_data_list?.find((x: any) => x.rotation !== undefined)?.rotation || 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  if (width < 160 || height < 160) throw new Error('The source video dimensions are invalid or too small.');
  return { duration, width, height, format: String(parsed.format?.format_name || ''), videoCodec: String(video.codec_name || ''), audioCodec: String(audio.codec_name || '') };
}

async function processProject(id: string) {
  const project = await readProject(id);
  const controller = controllers.get(id) || new AbortController();
  controllers.set(id, controller);
  const signal = controller.signal;
  const dir = projectDir(id);
  try {
    abortCheck(project, signal);
    project.status = 'processing'; project.stage = 'Preparing source video'; project.progress = 5;
    addLog(project, 'Preparing the source video.'); await persist(project);

    let sourcePath = project.sourcePath;
    if (!sourcePath || !(await fs.access(sourcePath).then(() => true).catch(() => false))) {
      if (!project.sourceUrl) throw new Error('The source video is no longer available. Please submit it again.');
      project.stage = 'Downloading video from the supplied social-media link'; project.progress = 10;
      addLog(project, 'Downloading the source video.'); await persist(project);
      sourcePath = await acquireSource(project.sourceUrl, dir, signal);
      project.sourcePath = sourcePath;
    }

    abortCheck(project, signal);
    project.stage = 'Checking source video and audio'; project.progress = 16; await persist(project);
    const media = await probeVideo(sourcePath);
    project.duration = media.duration; project.sourceWidth = media.width; project.sourceHeight = media.height;
    addLog(project, `Source checked: ${media.width}×${media.height}, ${media.duration.toFixed(1)} seconds, audio ${media.audioCodec}.`);
    await persist(project);

    abortCheck(project, signal);
    project.stage = 'Extracting recitation audio'; project.progress = 23; addLog(project, 'Extracting mono audio for recognition.'); await persist(project);
    const wavPath = path.join(dir, 'recitation.wav');
    await run('ffmpeg', ['-y', '-hide_banner', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath], { timeoutMs: 120_000, signal });
    const mp3Path = path.join(dir, 'recitation-ai.mp3');
    await run('ffmpeg', ['-y', '-hide_banner', '-i', wavPath, '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3Path], { timeoutMs: 90_000, signal });

    abortCheck(project, signal);
    if (!getGeminiApiKey()) throw new Error('Add your Gemini API key to the .env file (GEMINI_API_KEY) before processing Quran recitations.');
    project.stage = 'AI is transcribing the Arabic recitation with word timestamps'; project.progress = 34;
    addLog(project, 'Running Arabic speech transcription with word-level timing.'); await persist(project);
    const transcription = await transcribe(wavPath, media.duration);
    if (!transcription.words?.length) throw new Error('Arabic transcription did not return word-level timestamps.');
    project.transcript = transcription.text;
    await fs.writeFile(path.join(dir, 'arabic-transcript.txt'), transcription.text, 'utf8');
    await fs.writeFile(path.join(dir, 'timed-words.json'), JSON.stringify(transcription.words, null, 2), 'utf8');

    abortCheck(project, signal);
    project.stage = 'AI is identifying the recited Surah and Ayah sequence'; project.progress = 54;
    addLog(project, 'Matching the timed recitation against the complete supplied Quran database.'); await persist(project);
    const [localMatches, aiMatches] = await Promise.all([
      Promise.resolve(matchTimedTranscript(transcription.words, quranIndex)),
      identifyAyahsWithGemini(mp3Path, transcription.words, quranIndex),
    ]);
    const recognized = mergeAyahMatches(localMatches, aiMatches, media.duration);
    if (!recognized.length) {
      throw new Error('The recitation was transcribed, but no Ayah could be matched reliably against the supplied Hafs Quran database. Try a clearer recitation or a shorter clip.');
    }
    project.recognizedAyahs = recognized;
    await fs.writeFile(path.join(dir, 'recognized-ayahs.json'), JSON.stringify(recognized, null, 2), 'utf8');
    addLog(project, `Identified ${recognized.length} Ayah occurrence(s) across ${new Set(recognized.map((x) => x.surah)).size} Surah(s).`);
    await persist(project);

    abortCheck(project, signal);
    project.stage = project.backgroundMode === 'original' ? 'Rendering over the original video background' : 'Rendering a clean 9:16 black background';
    project.progress = 70; addLog(project, 'Rendering the Quran Arabic text and supplied English translation.'); await persist(project);
    const outputPath = path.join(dir, 'Quran-Video.mp4');
    const rendered = await renderQuranVideo({
      sourceVideo: sourcePath,
      outputVideo: outputPath,
      duration: media.duration,
      width: media.width,
      height: media.height,
      backgroundMode: project.backgroundMode,
      segments: recognized,
      signal,
    });
    const stat = await fs.stat(outputPath);
    if (stat.size < 50_000) throw new Error('The rendered MP4 appears incomplete or corrupted.');
    project.outputWidth = rendered.width; project.outputHeight = rendered.height;
    project.outputUrl = `/files/${encodeURIComponent(id)}/Quran-Video.mp4`;
    project.status = 'complete'; project.stage = 'Video ready'; project.progress = 100; project.error = undefined;
    addLog(project, `Finished MP4: ${rendered.width}×${rendered.height}, ${Math.round(stat.size / 1024 / 1024 * 10) / 10} MB.`);
    await persist(project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal.aborted || message.toLowerCase().includes('cancel')) {
      project.status = 'cancelled'; project.stage = 'Cancelled'; project.error = 'Processing was cancelled.';
      addLog(project, 'Processing cancelled.');
    } else {
      project.status = 'error'; project.stage = 'Could not finish video'; project.error = message;
      addLog(project, `Error: ${message}`);
      console.error(`[Project ${id}]`, error);
    }
    await persist(project).catch(() => {});
  } finally {
    controllers.delete(id);
  }
}

function pumpQueue() {
  while (running.size < 1 && queue.length) {
    const id = queue.shift()!;
    running.add(id);
    void processProject(id).finally(() => { running.delete(id); pumpQueue(); });
  }
}
function enqueue(id: string) { if (!queue.includes(id) && !running.has(id)) { queue.push(id); pumpQueue(); } }

function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!AUTH_TOKEN) return next();
  const header = String(req.headers.authorization || '');
  const query = typeof req.query.token === 'string' ? req.query.token : '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : query;
  if (candidate !== AUTH_TOKEN) return res.status(401).json({ error: 'Authentication required.' });
  next();
}

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
app.get('/api/health', (_req, res) => res.json({ ok: true, geminiConfigured: Boolean(getGeminiApiKey()), quranAyahs: quranIndex.verses.length, quranArabicFont: fsSync.existsSync(path.join(ROOT, 'data/fonts/Quran-Arabic-DigitalKhatt.otf')), quranEnglishFont: fsSync.existsSync(path.join(ROOT, 'data/fonts/English-Inter-Italic.ttf')) }));
app.get('/api/quran/summary', auth, (_req, res) => res.json({ surahs: 114, ayahs: quranIndex.verses.length, translation: 'Mustafa Khattab 2018', narration: 'Hafs (standard Quran database supplied)' }));
app.get('/api/projects', auth, async (_req, res) => res.json(await listProjects()));
app.get('/api/projects/:id', auth, async (req, res) => { try { res.json(await readProject(String(req.params.id))); } catch { res.status(404).json({ error: 'Project not found.' }); } });

app.post('/api/projects', auth, upload.single('video'), async (req, res) => {
  try {
    const url = typeof req.body.url === 'string' ? req.body.url.trim() : '';
    if (!req.file && !url) throw new Error('Paste a social-media link or upload a video.');
    if (req.file && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(req.file.originalname)) throw new Error('Upload an MP4, MOV, M4V, WebM, MKV or AVI video.');
    const backgroundMode = req.body.backgroundMode === 'black' ? 'black' : 'original';
    const id = randomUUID().replace(/-/g, '');
    const dir = projectDir(id);
    await fs.mkdir(dir, { recursive: true });
    let sourcePath: string | undefined;
    const sourceName = req.file?.originalname || url.split('?')[0].split('/').pop() || 'social-video';
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase() || '.mp4';
      sourcePath = path.join(dir, `source${ext}`);
      await fs.copyFile(req.file.path, sourcePath);
      await fs.unlink(req.file.path).catch(() => {});
    }
    const project: ProjectState = {
      id, name: safeName(sourceName.replace(/\.[^.]+$/, '') || 'quran-video'),
      status: 'queued', stage: 'Waiting to process', progress: 0,
      createdAt: now(), updatedAt: now(), sourceName, sourceUrl: url || undefined,
      sourcePath, backgroundMode, logs: [],
    };
    addLog(project, `Job created with ${backgroundMode === 'original' ? 'original background' : 'black 9:16 background'}.`);
    await persist(project);
    enqueue(id);
    res.status(202).json(project);
  } catch (error) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create the project.' });
  }
});

app.post('/api/projects/:id/cancel', auth, async (req, res) => {
  try {
    const project = await readProject(String(req.params.id));
    if (project.status === 'complete') throw new Error('The completed video cannot be cancelled.');
    project.status = 'cancelled'; project.stage = 'Cancelled'; project.error = 'Processing was cancelled.';
    const controller = controllers.get(project.id); controller?.abort();
    const queuedIndex = queue.indexOf(project.id); if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    addLog(project, 'Cancellation requested.'); await persist(project);
    res.json(project);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not cancel job.' }); }
});

app.delete('/api/projects/:id', auth, async (req, res) => {
  try {
    const project = await readProject(String(req.params.id));
    if (project.status === 'processing' || project.status === 'queued') throw new Error('Cancel the job before deleting it.');
    await fs.rm(projectDir(project.id), { recursive: true, force: true });
    active.delete(project.id);
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not delete project.' }); }
});

app.get('/files/:id/:name', auth, async (req, res) => {
  try {
    const id = String(req.params.id).replace(/[^a-f0-9]/gi, '');
    const name = path.basename(String(req.params.name));
    const base = path.resolve(projectDir(id));
    const target = path.resolve(base, name);
    if (!target.startsWith(`${base}${path.sep}`)) return res.status(403).end();
    const stat = await fs.stat(target);
    if (!stat.isFile()) return res.status(404).end();
    const ext = path.extname(target).toLowerCase();
    const type = ext === '.mp4' ? 'video/mp4' : ext === '.json' ? 'application/json' : 'text/plain; charset=utf-8';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (ext === '.mp4') res.setHeader('Content-Disposition', 'inline');
    fsSync.createReadStream(target).pipe(res);
  } catch { res.status(404).json({ error: 'File not found.' }); }
});

const hasClientDist = NODE_ENV === 'production' && await fs.access(path.join(CLIENT_DIST, 'index.html')).then(() => true).catch(() => false);
if (hasClientDist) {
  app.use(express.static(CLIENT_DIST, { index: 'index.html', maxAge: 0 }));
  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/files')) return res.status(404).end();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, host: '0.0.0.0' }, appType: 'custom', root: ROOT, configFile: path.join(ROOT, 'client/vite.config.ts') });
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/files')) return next();
    try {
      const template = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (error) { vite.ssrFixStacktrace(error as Error); next(error); }
  });
}

async function recoverInterruptedProjects() {
  const names = await fs.readdir(PROJECT_DIR).catch(() => [] as string[]);
  for (const name of names) {
    if (!/^[a-f0-9]{20,40}$/i.test(name)) continue;
    try {
      const project = JSON.parse(await fs.readFile(projectFile(name), 'utf8')) as ProjectState;
      if (project.status !== 'queued' && project.status !== 'processing') continue;
      project.status = 'error';
      project.stage = 'Interrupted by server restart';
      project.error = 'The server restarted before this video finished. Submit the source again to create a new video.';
      addLog(project, 'An unfinished job was marked interrupted during startup recovery.');
      await persist(project);
    } catch (error) {
      console.warn(`[Recovery] Could not inspect project ${name}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

await recoverInterruptedProjects();
app.listen(PORT, HOST, () => console.log(`Quran Video Creator listening on http://${HOST}:${PORT}`));
