import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { getGeminiApiKey } from './config.js';
import type { TimedWord } from './types.js';

export interface QuranVerse {
  surah: number;
  ayah: number;
  surahName: string;
  arabic: string;
  english: string;
  tokens: string[];
}
export interface QuranAyahSegment {
  id: string;
  surah: number;
  ayah: number;
  start: number;
  end: number;
  arabic: string;
  english: string;
  confidence: number;
  source: 'transcript-alignment' | 'gemini-audio';
}
interface ArabicSurah { id: number; name: string; total_verses: number; verses: Array<{ id: number; text: string }> }
interface EnglishSurah { Ayahs: Record<string, { 'Mustafa Khattab 2018': string }>; }
interface QuranIndex {
  verses: QuranVerse[];
  byRef: Map<string, QuranVerse>;
  flat: Array<{ token: string; verseKey: string; versePosition: number }>;
  ngrams: Map<string, number[]>;
}

let cachedIndex: QuranIndex | undefined;
const ROOT = process.cwd();

function decodeHtml(value: string): string {
  return value
    .replace(/<\/?i>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeArabicToken(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]/g, '')
    .replace(/[ـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ي')
    .replace(/[ى]/g, 'ي')
    .replace(/[ة]/g, 'ه')
    .replace(/[^\u0621-\u064A]/g, '');
}

export function tokenizeArabic(value: string): string[] {
  return value.split(/\s+/).map(normalizeArabicToken).filter(Boolean);
}

export async function loadQuranIndex(): Promise<QuranIndex> {
  if (cachedIndex) return cachedIndex;
  const [arRaw, enRaw] = await Promise.all([
    fs.readFile(path.join(ROOT, 'data/quran/ar.json'), 'utf8'),
    fs.readFile(path.join(ROOT, 'data/quran/en-mustafa-khattab-2018.json'), 'utf8'),
  ]);
  const arabic = JSON.parse(arRaw) as ArabicSurah[];
  const english = JSON.parse(enRaw) as Record<string, EnglishSurah>;
  if (!Array.isArray(arabic) || arabic.length !== 114) throw new Error('Arabic Quran database must contain all 114 Surahs.');
  if (Object.keys(english).length !== 114) throw new Error('English Quran database must contain all 114 Surahs.');

  const verses: QuranVerse[] = [];
  const byRef = new Map<string, QuranVerse>();
  const flat: QuranIndex['flat'] = [];
  for (const surah of arabic) {
    const translatedSurah = english[String(surah.id)];
    if (!translatedSurah?.Ayahs) throw new Error(`English translation is missing Surah ${surah.id}.`);
    if (surah.verses.length !== surah.total_verses) throw new Error(`Arabic Surah ${surah.id} has an unexpected Ayah count.`);
    for (const ayah of surah.verses) {
      const rawTranslation = translatedSurah.Ayahs[String(ayah.id)]?.['Mustafa Khattab 2018'];
      if (typeof rawTranslation !== 'string') throw new Error(`The supplied English translation is missing ${surah.id}:${ayah.id}.`);
      const verse: QuranVerse = {
        surah: surah.id,
        ayah: ayah.id,
        surahName: surah.name,
        arabic: ayah.text,
        english: decodeHtml(rawTranslation),
        tokens: tokenizeArabic(ayah.text),
      };
      verses.push(verse);
      byRef.set(`${surah.id}:${ayah.id}`, verse);
      verse.tokens.forEach((token, versePosition) => flat.push({ token, verseKey: `${surah.id}:${ayah.id}`, versePosition }));
    }
  }
  if (verses.length !== 6236 || flat.length < 70_000) throw new Error(`Quran database integrity check failed (${verses.length} Ayahs, ${flat.length} words).`);

  const ngrams = new Map<string, number[]>();
  for (let i = 0; i < flat.length - 1; i++) {
    for (const n of [2, 3]) {
      if (i + n > flat.length) continue;
      const key = flat.slice(i, i + n).map((x) => x.token).join(' ');
      if (!key || key.length < 5) continue;
      const positions = ngrams.get(key) || [];
      positions.push(i);
      ngrams.set(key, positions);
    }
  }
  cachedIndex = { verses, byRef, flat, ngrams };
  return cachedIndex;
}

function alignChunk(query: Array<{ token: string; sourceIndex: number }>, index: QuranIndex, offset: number) {
  const n = query.length;
  const start = Math.max(0, Math.min(index.flat.length - 1, offset - 7));
  const end = Math.min(index.flat.length, Math.max(start + 1, offset + n + 18));
  const target = index.flat.slice(start, end);
  const m = target.length;
  const cols = m + 1;
  const dp = new Float32Array((n + 1) * cols);
  const dir = new Uint8Array((n + 1) * cols);
  for (let j = 0; j <= m; j++) { dp[j] = 0; dir[j] = 3; }
  for (let i = 1; i <= n; i++) { dp[i * cols] = i * 1.28; dir[i * cols] = 2; }
  for (let i = 1; i <= n; i++) {
    const q = query[i - 1].token;
    for (let j = 1; j <= m; j++) {
      const t = target[j - 1].token;
      const exact = q === t;
      const substitution = dp[(i - 1) * cols + j - 1] + (exact ? 0 : 1.55);
      const dropTranscript = dp[(i - 1) * cols + j] + 1.28;
      const skipQuran = dp[i * cols + j - 1] + 0.92;
      const k = i * cols + j;
      if (substitution <= dropTranscript && substitution <= skipQuran) { dp[k] = substitution; dir[k] = 1; }
      else if (dropTranscript <= skipQuran) { dp[k] = dropTranscript; dir[k] = 2; }
      else { dp[k] = skipQuran; dir[k] = 3; }
    }
  }
  let bestJ = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let j = 1; j <= m; j++) {
    const cost = dp[n * cols + j];
    if (cost < bestCost) { bestCost = cost; bestJ = j; }
  }
  const pairs: Array<{ transcriptIndex: number; quranIndex: number; verseKey: string }> = [];
  let i = n;
  let j = bestJ;
  while (i > 0 && j >= 0) {
    const d = dir[i * cols + j];
    if (d === 1) {
      if (query[i - 1].token === target[j - 1]?.token) {
        pairs.push({ transcriptIndex: query[i - 1].sourceIndex, quranIndex: start + j - 1, verseKey: target[j - 1].verseKey });
      }
      i--; j--;
    } else if (d === 2) i--;
    else if (d === 3) j--;
    else break;
  }
  return { pairs: pairs.reverse(), exact: pairs.length, cost: bestCost / Math.max(1, n) };
}

export function matchTimedTranscript(words: TimedWord[], index: QuranIndex): QuranAyahSegment[] {
  const transcript = words.map((word, sourceIndex) => ({ token: normalizeArabicToken(word.text), sourceIndex })).filter((x) => x.token.length > 0);
  if (transcript.length < 3) return [];
  const uniquePairs = new Map<string, { transcriptIndex: number; quranIndex: number; verseKey: string }>();
  const chunkSize = 24;
  const step = 12;
  let previousCandidateOffset = -1;
  for (let offset = 0; offset < transcript.length; offset += step) {
    const chunk = transcript.slice(offset, Math.min(transcript.length, offset + chunkSize));
    if (chunk.length < 3) continue;
    const gram = chunk.length >= 9 ? 3 : 2;
    const votes = new Map<number, number>();
    for (let i = 0; i <= chunk.length - gram; i++) {
      const key = chunk.slice(i, i + gram).map((x) => x.token).join(' ');
      const positions = index.ngrams.get(key);
      if (!positions || positions.length > 40) continue;
      for (const position of positions) {
        const candidate = position - i;
        votes.set(candidate, (votes.get(candidate) || 0) + 1);
      }
    }
    const candidates = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const minimumExact = chunk.length <= 8 ? 2 : Math.max(3, Math.floor(chunk.length * 0.16));
    let best: { offset: number; votes: number; aligned: ReturnType<typeof alignChunk>; continuity: number } | undefined;
    for (const [candidateOffset, voteCount] of candidates) {
      if (voteCount < 1) continue;
      const aligned = alignChunk(chunk, index, candidateOffset);
      if (aligned.exact < minimumExact || aligned.cost > 1.05) continue;
      const continuity = previousCandidateOffset < 0 ? 0 : Math.abs(candidateOffset - (previousCandidateOffset + step));
      const candidate = { offset: candidateOffset, votes: voteCount, aligned, continuity };
      if (!best || candidate.aligned.exact > best.aligned.exact ||
        (candidate.aligned.exact === best.aligned.exact && candidate.aligned.cost < best.aligned.cost - 0.001) ||
        (candidate.aligned.exact === best.aligned.exact && Math.abs(candidate.aligned.cost - best.aligned.cost) <= 0.001 && candidate.votes > best.votes) ||
        (candidate.aligned.exact === best.aligned.exact && Math.abs(candidate.aligned.cost - best.aligned.cost) <= 0.001 && candidate.votes === best.votes && candidate.continuity < best.continuity)) {
        best = candidate;
      }
    }
    // Keep just the strongest corpus location for each timed transcript chunk.
    // Accumulating several repeated Quran phrases at once used to fragment the
    // timeline into competing Surahs and could suppress a perfectly good match.
    if (best) {
      for (const pair of best.aligned.pairs) uniquePairs.set(`${pair.transcriptIndex}:${pair.quranIndex}`, pair);
      previousCandidateOffset = best.offset;
    }
  }

  const pairs = [...uniquePairs.values()].sort((a, b) => a.transcriptIndex - b.transcriptIndex);
  if (!pairs.length) return [];
  const groups: Array<{ verseKey: string; pairs: typeof pairs }> = [];
  let current: typeof groups[number] | undefined;
  let previous: typeof pairs[number] | undefined;
  for (const pair of pairs) {
    const word = words[pair.transcriptIndex];
    const prevWord = previous ? words[previous.transcriptIndex] : undefined;
    const contiguous = Boolean(current && previous && current.verseKey === pair.verseKey && pair.transcriptIndex - previous.transcriptIndex <= 5 && word.start - (prevWord?.end || 0) < 3.5 && pair.quranIndex >= previous.quranIndex);
    if (!contiguous) {
      current = { verseKey: pair.verseKey, pairs: [] };
      groups.push(current);
    }
    current!.pairs.push(pair);
    previous = pair;
  }

  const raw: Array<{ verse: QuranVerse; start: number; end: number; confidence: number; source: 'transcript-alignment' }> = [];
  for (const group of groups) {
    const verse = index.byRef.get(group.verseKey);
    if (!verse) continue;
    const distinctQuranWords = new Set(group.pairs.map((p) => p.quranIndex)).size;
    const minimum = Math.min(3, Math.max(1, verse.tokens.length));
    if (distinctQuranWords < minimum) continue;
    const startWord = Math.min(...group.pairs.map((p) => words[p.transcriptIndex].start));
    const endWord = Math.max(...group.pairs.map((p) => words[p.transcriptIndex].end));
    raw.push({ verse, start: startWord, end: endWord, confidence: Math.min(0.99, 0.58 + (distinctQuranWords / Math.max(1, verse.tokens.length)) * 0.42), source: 'transcript-alignment' });
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: typeof raw = [];
  for (const item of raw) {
    const last = merged[merged.length - 1];
    if (last && last.verse.surah === item.verse.surah && last.verse.ayah === item.verse.ayah && item.start - last.end < 3.8) {
      last.end = Math.max(last.end, item.end);
      last.confidence = Math.max(last.confidence, item.confidence);
    } else merged.push({ ...item });
  }
  return merged.map((item, i) => ({
    id: `${item.verse.surah}:${item.verse.ayah}:${item.start.toFixed(2)}`,
    surah: item.verse.surah, ayah: item.verse.ayah,
    start: Math.max(0, item.start),
    end: Math.max(item.start + 0.25, merged[i + 1] ? merged[i + 1].start - 0.04 : item.end + 0.55),
    arabic: item.verse.arabic, english: item.verse.english,
    confidence: item.confidence, source: 'transcript-alignment',
  }));
}

function parseJsonText(text: string): any {
  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
  }
  return null;
}

function overlapRatio(expected: string[], actual: string[]): number {
  if (!expected.length || !actual.length) return 0;
  const small = expected.length <= actual.length ? expected : actual;
  const large = expected.length <= actual.length ? actual : expected;
  let matched = 0;
  let cursor = 0;
  for (const word of small) {
    const found = large.indexOf(word, cursor);
    if (found >= 0) { matched++; cursor = found + 1; }
  }
  return matched / Math.max(1, small.length);
}

export async function identifyAyahsWithGemini(audioPath: string, words: TimedWord[], index: QuranIndex): Promise<QuranAyahSegment[]> {
  const apiKey = getGeminiApiKey();
  if (!apiKey || !words.length) return [];
  const ai = new GoogleGenAI({ apiKey }) as any;
  let audio: Buffer;
  let uploaded: any = null;
  const mimeType = audioPath.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
  try {
    audio = await fs.readFile(audioPath);
    if (audio.byteLength > 19_000_000) {
      uploaded = await ai.files.upload({ file: audioPath, config: { mimeType } });
    }
  } catch (error) {
    console.warn('[Quran AI match] Could not prepare the audio for the independent recognition pass; transcript alignment remains active:', error instanceof Error ? error.message : String(error));
    return [];
  }
  const transcriptLines = words.map((w) => `[${w.index}] ${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`).join('\n');
  const prompt = `You are a specialist Quran recitation recognition system. Listen to the attached audio and identify every Quranic Ayah that is actually recited, in chronological order. The recitation is expected to use the standard Hafs narration represented by the supplied Quran database. Use the indexed, time-stamped Arabic transcript as an alignment aid, but listen to the audio too.\n\nReturn ONLY valid JSON in this exact structure: {"segments":[{"surah":1,"ayah":1,"startWord":0,"endWord":6,"confidence":0.98}]}. Surah and Ayah are 1-based Quran numbers. startWord/endWord refer to the inclusive word indices in the transcript below, not the array position. Each output item must represent one verse, not a whole passage. Include partial verses when only a portion is recited. Do not guess from meaning, do not invent references, and omit anything you cannot identify with high confidence. Keep repeated recitations as separate timed entries. Confidence must be between 0 and 1.\n\nDURATION: ${words.length ? words[words.length - 1].end.toFixed(2) : 0} seconds\nTIMED ARABIC TRANSCRIPT:\n${transcriptLines}`;
  const parts = uploaded
    ? [{ fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType || mimeType } }, { text: prompt }]
    : [{ inlineData: { mimeType, data: audio.toString('base64') } }, { text: prompt }];
  const model = process.env.QURAN_MATCH_MODEL || 'gemini-flash-latest';
  try {
    const response: any = await ai.models.generateContent({ model, contents: [{ role: 'user', parts }] , config: { responseMimeType: 'application/json' } });
    const parsed = parseJsonText(String(response.text || ''));
    const proposed = Array.isArray(parsed?.segments) ? parsed.segments : [];
    const result: QuranAyahSegment[] = [];
    for (const candidate of proposed) {
      const surah = Number(candidate.surah);
      const ayah = Number(candidate.ayah);
      const startWord = Number(candidate.startWord);
      const endWord = Number(candidate.endWord);
      const confidence = Number(candidate.confidence);
      const verse = index.byRef.get(`${surah}:${ayah}`);
      if (!verse || !Number.isInteger(startWord) || !Number.isInteger(endWord) || !Number.isFinite(confidence) || startWord < 0 || endWord < startWord || endWord >= words.length || confidence < 0.45) continue;
      const actual = words.slice(startWord, endWord + 1).map((w) => normalizeArabicToken(w.text)).filter(Boolean);
      const ratio = overlapRatio(verse.tokens, actual);
      // Even an audio-model prediction must have some lexical support in the timed Arabic transcript.
      // This is a safety gate, not a user confirmation step; weak matches are simply not displayed.
      if (ratio < 0.18) continue;
      const start = words[startWord].start;
      const end = Math.max(start + 0.25, words[endWord].end);
      result.push({
        id: `${surah}:${ayah}:${start.toFixed(2)}`, surah, ayah, start, end,
        arabic: verse.arabic, english: verse.english,
        confidence: Math.min(confidence, ratio >= 0.5 ? 0.99 : confidence), source: 'gemini-audio',
      });
    }
    return result.sort((a, b) => a.start - b.start);
  } catch (error) {
    console.warn('[Quran AI match] Gemini audio identification unavailable; transcript alignment remains active:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

export function mergeAyahMatches(local: QuranAyahSegment[], ai: QuranAyahSegment[], duration: number): QuranAyahSegment[] {
  const result = [...local];
  for (const candidate of ai) {
    const localMatch = result.find((x) => x.surah === candidate.surah && x.ayah === candidate.ayah && Math.abs(x.start - candidate.start) < 4);
    if (localMatch) {
      // Keep transcript-derived timing, but let the independent audio model reinforce the confidence score.
      localMatch.confidence = Math.max(localMatch.confidence, candidate.confidence);
      continue;
    }
    const overlap = result.find((x) => candidate.start < x.end && candidate.end > x.start);
    if (!overlap && candidate.confidence >= 0.72) result.push(candidate);
  }
  result.sort((a, b) => a.start - b.start);
  const deduped: QuranAyahSegment[] = [];
  for (const item of result) {
    const last = deduped[deduped.length - 1];
    if (last && last.surah === item.surah && last.ayah === item.ayah && item.start - last.end < 3) {
      last.end = Math.max(last.end, item.end);
      last.confidence = Math.max(last.confidence, item.confidence);
    } else deduped.push({ ...item });
  }
  return deduped.map((item, i) => {
    const next = deduped[i + 1];
    // Keep the final Ayah on screen only through the end of its actual recitation,
    // not all the way to the end of a video that may contain a long outro.
    const proposedEnd = next && next.start > item.start ? next.start - 0.04 : item.end;
    return { ...item, end: Math.min(duration, Math.max(item.start + 0.25, proposedEnd)) };
  });
}

export function toArabicIndic(value: number): string {
  return String(value).replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}
