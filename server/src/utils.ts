import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import ffprobeStatic from 'ffprobe-static';
import ffmpegStatic from 'ffmpeg-static';

const staticFfprobePath: string | undefined =
  (ffprobeStatic as any)?.path ||
  (ffprobeStatic as any)?.default?.path ||
  (typeof ffprobeStatic === 'string' ? ffprobeStatic : undefined);

const staticFfmpegPath: string | undefined =
  (typeof ffmpegStatic === 'string' ? ffmpegStatic : undefined) ||
  (ffmpegStatic as any)?.default ||
  (ffmpegStatic as any)?.path;

// Ensure executable permissions and prepend static bin directories to PATH
try {
  if (staticFfprobePath && fsSync.existsSync(staticFfprobePath)) {
    try { fsSync.chmodSync(staticFfprobePath, 0o755); } catch {}
    const dir = path.dirname(staticFfprobePath);
    if (!process.env.PATH?.split(':').includes(dir)) {
      process.env.PATH = `${dir}:${process.env.PATH || ''}`;
    }
  }
  if (staticFfmpegPath && fsSync.existsSync(staticFfmpegPath)) {
    try { fsSync.chmodSync(staticFfmpegPath, 0o755); } catch {}
    const dir = path.dirname(staticFfmpegPath);
    if (!process.env.PATH?.split(':').includes(dir)) {
      process.env.PATH = `${dir}:${process.env.PATH || ''}`;
    }
  }
} catch (e) {
  console.warn('[PATH Init] Note:', e);
}

export function resolveBinary(cmd: string): string {
  if (cmd === 'ffprobe') {
    try {
      const res = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
      if (res.status === 0) return 'ffprobe';
    } catch {}
    if (staticFfprobePath && fsSync.existsSync(staticFfprobePath)) {
      return staticFfprobePath;
    }
    return 'ffprobe';
  }
  if (cmd === 'ffmpeg') {
    try {
      const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      if (res.status === 0) return 'ffmpeg';
    } catch {}
    if (staticFfmpegPath && fsSync.existsSync(staticFfmpegPath)) {
      return staticFfmpegPath;
    }
    return 'ffmpeg';
  }
  return cmd;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const resolvedCmd = resolveBinary(cmd);
  const runEnv = { ...process.env, ...options.env };

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(resolvedCmd, args, { cwd: options.cwd, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finishResolve = (value: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          finishReject(new Error(`${cmd} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;

    const abort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
      finishReject(new Error(`${cmd} cancelled`));
    };
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e: any) => {
      if (e?.code === 'ENOENT') {
        if (cmd === 'ffprobe' && staticFfprobePath && resolvedCmd !== staticFfprobePath) {
          if (timer) clearTimeout(timer);
          run(staticFfprobePath, args, options).then(finishResolve, finishReject);
          return;
        }
        if (cmd === 'ffmpeg' && staticFfmpegPath && resolvedCmd !== staticFfmpegPath) {
          if (timer) clearTimeout(timer);
          run(staticFfmpegPath, args, options).then(finishResolve, finishReject);
          return;
        }
      }
      finishReject(e instanceof Error ? e : new Error(String(e)));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abort);
      if (settled) return;
      if (code === 0) finishResolve({ stdout, stderr });
      else finishReject(new Error(`${cmd} exited ${code}: ${stderr.slice(-5000)}`));
    });
  });
}

export async function exists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

export function safeName(name: string) {
  return name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120) || 'file';
}

export function generateRandom4(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let res = '';
  for (let i = 0; i < 4; i++) {
    res += chars[Math.floor(Math.random() * chars.length)];
  }
  return res;
}

export function getRatioCode(width: number, height: number, name = ''): string {
  const lower = name.toLowerCase();
  // 9:16 -> 1
  if ((width === 1080 && height === 1920) || lower.includes('9:16') || lower.includes('9-16')) return '1';
  // 16:9 -> 2
  if ((width === 1920 && height === 1080) || lower.includes('16:9') || lower.includes('16-9')) return '2';
  // 3:4 -> 3 (Preset 3)
  if ((width === 1080 && height === 1440) || lower.includes('3:4') || lower.includes('3-4')) return '3';
  // 4:3 -> 4 (Preset 4)
  if ((width === 1440 && height === 1080) || lower.includes('4:3') || lower.includes('4-3')) return '4';
  return '1';
}

export function formatVideoOutputName(width: number, height: number, name = '', randomCode?: string): string {
  const code = getRatioCode(width, height, name);
  const rand = randomCode || generateRandom4();
  return `${code} (${rand}).mp4`;
}

export function srtTime(sec: number) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

export function escapeAssText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

export function hexToAss(hex: string) {
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2), g = clean.slice(2, 4), b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

export function assAlignment(align: 'left' | 'center' | 'right', vertical: 'top' | 'middle' | 'bottom') {
  if (vertical === 'top') return align === 'left' ? 7 : align === 'right' ? 9 : 8;
  if (vertical === 'middle') return align === 'left' ? 4 : align === 'right' ? 6 : 5;
  return align === 'left' ? 1 : align === 'right' ? 3 : 2;
}

export function backoffDelay(attempt: number, base = 800, cap = 15_000) {
  const exponential = Math.min(cap, base * (2 ** attempt));
  const jitter = Math.floor(Math.random() * Math.max(100, exponential * 0.35));
  return exponential + jitter;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function percentile(values: number[], p: number) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function parseDurationOffset(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const m = value.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)s?$/);
  if (!m) {
    const simple = Number(value.replace(/s$/, ''));
    return Number.isFinite(simple) ? simple : undefined;
  }
  return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}
