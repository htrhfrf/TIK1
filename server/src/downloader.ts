import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { ALLOW_GENERIC_URLS, MAX_URL_MB } from './config.js';
import { run, safeName } from './utils.js';

const MAX_URL_BYTES = MAX_URL_MB * 1024 * 1024;
const USER_AGENT = 'QuranVideoCreator/1.0';
const ALLOWED_PLATFORM_HOSTS = [
  'youtube.com', 'youtu.be', 'www.youtube.com', 'm.youtube.com',
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'douyin.com', 'www.douyin.com',
  'instagram.com', 'www.instagram.com', 'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
  'reddit.com', 'www.reddit.com', 'v.redd.it',
];

export function extractUrl(input: string) {
  if (!input) return '';
  const match = input.match(/https?:\/\/[^\s"'<>\\]+/i);
  return match ? match[0].trim() : input.trim();
}

function hostnameAllowed(hostname: string) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return ALLOWED_PLATFORM_HOSTS.some((allowed) => host === allowed.replace(/^www\./, '') || host.endsWith(`.${allowed.replace(/^www\./, '')}`));
}

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split('.').map(Number);
    if ([a, b, c, d].some((n) => !Number.isInteger(n))) return true;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) || (a === 198 && b >= 18 && b <= 19) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
      a >= 224;
  }
  const normalized = ip.toLowerCase().split('%')[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  return false;
}

async function assertSafeExternalUrl(rawUrl: string, allowGeneric = ALLOW_GENERIC_URLS) {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error('Invalid URL.'); }
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS video URLs are allowed.');
  if (!allowGeneric && !hostnameAllowed(parsed.hostname)) throw new Error('This URL host is not in the approved video-import allowlist. Upload the file directly or enable ALLOW_GENERIC_URLS explicitly.');
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) throw new Error('Blocked URL: the destination resolves to a private or reserved network address.');
  return parsed;
}

async function fetchSafe(url: string, init: RequestInit = {}, opts: { maxBytes?: number; maxRedirects?: number; timeoutMs?: number; allowGeneric?: boolean; signal?: AbortSignal } = {}) {
  let current = url;
  for (let redirects = 0; redirects <= (opts.maxRedirects ?? 4); redirects++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    await assertSafeExternalUrl(current, opts.allowGeneric);
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
    const fetchSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
    const response = await fetch(current, { ...init, redirect: 'manual', signal: fetchSignal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Remote server returned a redirect without a location.');
      current = new URL(location, current).toString();
      continue;
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length && length > (opts.maxBytes ?? MAX_URL_BYTES)) throw new Error('Remote video exceeds the configured download size limit.');
    return response;
  }
  throw new Error('Too many redirects while downloading video.');
}

async function writeResponse(response: Response, target: string, maxBytes = MAX_URL_BYTES, signal?: AbortSignal) {
  if (!response.ok || !response.body) throw new Error(`Remote download failed with HTTP ${response.status}.`);
  const writer = createWriteStream(target);
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new Error('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Remote video exceeded the configured download size limit.');
      if (!writer.write(Buffer.from(value))) await new Promise<void>((resolve) => writer.once('drain', () => resolve()));
    }
    writer.end();
    await new Promise<void>((resolve, reject) => { writer.once('finish', resolve); writer.once('error', reject); });
  } catch (error) {
    writer.destroy();
    throw error;
  }
  return bytes;
}

export async function acquireSource(rawInput: string, outDir: string, signal?: AbortSignal) {
  await fs.mkdir(outDir, { recursive: true });
  const url = extractUrl(rawInput);
  if (!url) throw new Error('Please provide a valid video URL.');
  if (signal?.aborted) throw new Error('cancelled');
  await assertSafeExternalUrl(url);
  console.log(`[Downloader] Starting video extraction for: ${url}`);

  if (/tiktok\.com|douyin\.com/i.test(new URL(url).hostname)) return extractTikTok(url, outDir, signal);

  const isDirect = /\.(mp4|mov|m4v|webm|mkv)(?:\?.*)?$/i.test(url);
  if (isDirect) {
    try {
      const ext = new URL(url).pathname.split('.').pop() || 'mp4';
      const target = path.join(outDir, `source.${safeName(ext)}`);
      const response = await fetchSafe(url, { headers: { 'User-Agent': USER_AGENT } }, { timeoutMs: 90_000, signal });
      await writeResponse(response, target, MAX_URL_BYTES, signal);
      const stat = await fs.stat(target);
      if (stat.size > 10_000) return target;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.message.includes('cancelled'))) throw error;
      console.warn('[Downloader] Direct download failed; trying yt-dlp:', error instanceof Error ? error.message : String(error));
    }
  }
  return extractWithYtDlp(url, outDir, signal);
}

async function extractTikTok(url: string, outDir: string, signal?: AbortSignal) {
  const target = path.join(outDir, 'source.mp4');
  let resolvedUrl = url;
  if (signal?.aborted) throw new Error('cancelled');
  try {
    const headRes = await fetchSafe(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' } }, { timeoutMs: 15_000, signal });
    if (headRes.url) resolvedUrl = headRes.url;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[Downloader] Short URL resolution notice:', err instanceof Error ? err.message : String(err));
  }

  const tikwmEndpoints = [
    `https://www.tikwm.com/api/?url=${encodeURIComponent(resolvedUrl)}`,
    `https://tikwm.com/api/?url=${encodeURIComponent(resolvedUrl)}`,
  ];
  for (const endpoint of tikwmEndpoints) {
    if (signal?.aborted) throw new Error('cancelled');
    try {
      const response = await fetchSafe(endpoint, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, { timeoutMs: 15_000, allowGeneric: true, signal });
      const data = await response.json() as any;
      const videoUrl = data?.data?.play || data?.data?.hdplay || data?.data?.wmplay;
      if (!videoUrl) continue;
      const candidate = new URL(videoUrl, 'https://www.tikwm.com').toString();
      const videoResponse = await fetchSafe(candidate, { headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.tikwm.com/' } }, { timeoutMs: 90_000, allowGeneric: true, signal });
      await writeResponse(videoResponse, target, MAX_URL_BYTES, signal);
      if ((await fs.stat(target)).size > 10_000) return target;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[Downloader] TikWM attempt failed:', err instanceof Error ? err.message : String(err));
    }
  }

  try {
    if (signal?.aborted) throw new Error('cancelled');
    const form = new URLSearchParams({ id: resolvedUrl, locale: 'en', tt: '0' });
    const response = await fetchSafe('https://ssstik.io/abc?url=dl', { method: 'POST', headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: 'https://ssstik.io', Referer: 'https://ssstik.io/en' }, body: form.toString() }, { timeoutMs: 20_000, allowGeneric: true, signal });
    const html = await response.text();
    const match = html.match(/href="([^"]+)"[^>]*class="[^"]*without_watermark[^"]*"/i) || html.match(/class="[^"]*without_watermark[^"]*"[^>]*href="([^"]+)"/i) || html.match(/href="([^"]+)"[^>]*download/i);
    if (match?.[1]) {
      const videoResponse = await fetchSafe(match[1], { headers: { 'User-Agent': USER_AGENT, Referer: 'https://ssstik.io/' } }, { timeoutMs: 90_000, allowGeneric: true, signal });
      await writeResponse(videoResponse, target, MAX_URL_BYTES, signal);
      if ((await fs.stat(target)).size > 10_000) return target;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[Downloader] SSStik attempt failed:', err instanceof Error ? err.message : String(err));
  }

  return extractWithYtDlp(resolvedUrl, outDir, signal);
}

async function extractWithYtDlp(url: string, outDir: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('cancelled');
  await assertSafeExternalUrl(url);
  const output = path.join(outDir, 'source.%(ext)s');
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--prefer-free-formats',
    '--merge-output-format', 'mp4',
    '--max-filesize', `${MAX_URL_MB}M`,
    '--user-agent', USER_AGENT,
    '-o', output,
    url,
  ];
  try {
    await run('yt-dlp', args, { timeoutMs: 180_000, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[Downloader] yt-dlp first pass notice:', err instanceof Error ? err.message : String(err));
    // Try generic format download
    const fallbackArgs = [
      '--no-warnings',
      '--no-playlist',
      '-f', 'bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '-o', output,
      url,
    ];
    await run('yt-dlp', fallbackArgs, { timeoutMs: 180_000, signal });
  }

  const files = await fs.readdir(outDir);
  // Find any candidate video file
  const candidate = files.find((f) => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.startsWith('.') && /\.(mp4|mkv|webm|mov|m4v)$/i.test(f));
  if (!candidate) throw new Error('Video extractor completed but no valid video file was produced.');
  const resultPath = path.join(outDir, candidate);
  const stat = await fs.stat(resultPath);
  if (stat.size < 5_000) throw new Error('Extracted video file is empty or corrupted.');

  // If candidate is not source.mp4, remux or standardize to source.mp4
  const targetMp4 = path.join(outDir, 'source.mp4');
  if (resultPath !== targetMp4) {
    try {
      await run('ffmpeg', ['-y', '-i', resultPath, '-c', 'copy', targetMp4], { timeoutMs: 60_000 });
      if ((await fs.stat(targetMp4)).size > 5_000) {
        await fs.unlink(resultPath).catch(() => {});
        return targetMp4;
      }
    } catch {
      return resultPath;
    }
  }
  return targetMp4;
}
