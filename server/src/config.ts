import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

export const ROOT = path.resolve(process.cwd());
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const PROJECT_DIR = path.join(DATA_DIR, 'projects');
export const FONT_DIR = path.join(DATA_DIR, 'fonts');
export const CLIENT_DIST = path.join(ROOT, 'client', 'dist');
export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '127.0.0.1';
export const TRUST_PROXY = String(process.env.TRUST_PROXY).toLowerCase() === 'true';
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 300);
export const MAX_URL_MB = Number(process.env.MAX_URL_MB || 300);
export const MAX_VIDEO_SECONDS = Number(process.env.MAX_VIDEO_SECONDS || 600);
export const MAX_FONT_MB = Number(process.env.MAX_FONT_MB || 12);
export const MAX_BATCH_MB = Math.max(MAX_UPLOAD_MB, Number(process.env.MAX_BATCH_MB || 1000));
export const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1));
export const MAX_CONCURRENT_AI = Math.max(1, Number(process.env.MAX_CONCURRENT_AI || 2));
export const MAX_CONCURRENT_RENDERS = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDERS || 1));
export const PROJECT_RETENTION_DAYS = Math.max(1, Number(process.env.PROJECT_RETENTION_DAYS || 7));
export const UPLOAD_RETENTION_HOURS = Math.max(1, Number(process.env.UPLOAD_RETENTION_HOURS || 24));
export const AUTH_TOKEN = process.env.AUTH_TOKEN?.trim() || '';
export const CORS_ORIGIN = process.env.CORS_ORIGIN?.trim() || '';
export const ALLOW_INSECURE_PRODUCTION = String(process.env.ALLOW_INSECURE_PRODUCTION).toLowerCase() === 'true';
export const ALLOW_GENERIC_URLS = process.env.ALLOW_GENERIC_URLS ? String(process.env.ALLOW_GENERIC_URLS).toLowerCase() === 'true' : true;
export const DEMO_MODE = NODE_ENV !== 'production' && String(process.env.DEMO_MODE).toLowerCase() === 'true';
export const DEFAULT_TRANSLATION_MODEL_PRIORITY = [
  'gemini-flash-latest',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
] as const;

export const DEFAULT_TRANSCRIPTION_MODEL_PRIORITY = [
  'gemini-3.5-transcribe',
  'gemini-flash-latest',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
] as const;

export const TRANSLATION_MODEL_PRIORITY: string[] = process.env.TRANSLATION_MODEL_PRIORITY
  ? process.env.TRANSLATION_MODEL_PRIORITY.split(',').map((s) => s.trim()).filter(Boolean)
  : [...DEFAULT_TRANSLATION_MODEL_PRIORITY];

export const TRANSCRIPTION_MODEL_PRIORITY: string[] = process.env.TRANSCRIPTION_MODEL_PRIORITY
  ? process.env.TRANSCRIPTION_MODEL_PRIORITY.split(',').map((s) => s.trim()).filter(Boolean)
  : [...DEFAULT_TRANSCRIPTION_MODEL_PRIORITY];

export const GEMINI_TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe';
export const GEMINI_TRANSLATE_MODEL = process.env.GEMINI_TRANSLATE_MODEL || TRANSLATION_MODEL_PRIORITY[0] || 'gemini-3.6-flash';
export const GEMINI_POLISH_MODEL = process.env.GEMINI_POLISH_MODEL || TRANSLATION_MODEL_PRIORITY[0] || 'gemini-3.6-flash';
export const GEMINI_VERIFY_MODEL = process.env.GEMINI_VERIFY_MODEL || 'gemini-3.8-flash';
export const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY?.trim() || '';
export const GOOGLE_TRANSLATE_ACCESS_TOKEN = process.env.GOOGLE_TRANSLATE_ACCESS_TOKEN?.trim() || '';
export const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID?.trim() || '';
export const GOOGLE_CLOUD_GLOSSARY_ID = process.env.GOOGLE_CLOUD_GLOSSARY_ID?.trim() || '';
export const GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION?.trim() || (GOOGLE_CLOUD_GLOSSARY_ID ? 'us-central1' : 'global');
export const TRANSLATION_FALLBACK_URL = process.env.TRANSLATION_FALLBACK_URL?.trim() || '';
export const TRANSLATION_FALLBACK_API_KEY = process.env.TRANSLATION_FALLBACK_API_KEY?.trim() || '';

export function getGeminiApiKey(): string {
  const envVal = process.env.GEMINI_API_KEY;
  if (envVal && envVal.trim() && envVal !== 'MY_GEMINI_API_KEY') return envVal.trim();
  const searchPaths = [path.join(ROOT, '..', '.dev.env.json'), path.join(ROOT, '.dev.env.json'), '/app/.dev.env.json'];
  for (const p of searchPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
      const candidate = typeof parsed.GEMINI_API_KEY === 'string' ? parsed.GEMINI_API_KEY.trim() : '';
      if (candidate && candidate !== 'MY_GEMINI_API_KEY') {
        process.env.GEMINI_API_KEY = candidate;
        return candidate;
      }
    } catch {}
  }
  return envVal?.trim() || '';
}

export const GEMINI_API_KEY = getGeminiApiKey();

export function publicConfig() {
  return {
    maxUploadMb: MAX_UPLOAD_MB,
    maxBatchMb: MAX_BATCH_MB,
    maxVideoSeconds: MAX_VIDEO_SECONDS,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    maxConcurrentAi: MAX_CONCURRENT_AI,
    maxConcurrentRenders: MAX_CONCURRENT_RENDERS,
    authRequired: Boolean(AUTH_TOKEN),
    genericUrlsAllowed: ALLOW_GENERIC_URLS,
  };
}
