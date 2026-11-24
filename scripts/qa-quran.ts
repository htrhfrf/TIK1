import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadQuranIndex,
  matchTimedTranscript,
  mergeAyahMatches,
  normalizeArabicToken,
  toArabicIndic,
} from '../server/src/quran.js';

const index = await loadQuranIndex();
if (index.verses.length !== 6236) throw new Error(`Expected 6236 Ayahs, got ${index.verses.length}`);
if (index.flat.length < 70_000) throw new Error(`Arabic token index unexpectedly small (${index.flat.length}).`);

const required = ['1:1', '87:17', '2:282', '112:4'];
for (const ref of required) {
  const verse = index.byRef.get(ref);
  if (!verse?.arabic || !verse.english) throw new Error(`Missing Quran text or supplied translation for ${ref}`);
  if (/<[^>]+>|&#\d+;/i.test(verse.english)) throw new Error(`Translation markup/entities were not decoded for ${ref}`);
  if (!normalizeArabicToken(verse.arabic.split(/\s+/)[0])) throw new Error(`Arabic normalization failed for ${ref}`);
}

const testRefs = ['1:1', '1:2', '1:3', '1:4'];
const timedWords: Array<{ index: number; text: string; start: number; end: number }> = [];
let clock = 0;
for (const ref of testRefs) {
  const verse = index.byRef.get(ref)!;
  for (const text of verse.arabic.split(/\s+/)) {
    timedWords.push({ index: timedWords.length, text, start: clock, end: clock + 0.34 });
    clock += 0.39;
  }
  clock += 0.2;
}
const matched = matchTimedTranscript(timedWords, index).map((item) => `${item.surah}:${item.ayah}`);
for (const ref of testRefs) {
  if (!matched.includes(ref)) throw new Error(`Local timed Quran alignment failed to find ${ref}; found: ${matched.join(', ')}`);
}

const finalSegment = {
  id: '87:17:1.0', surah: 87, ayah: 17, start: 1, end: 2,
  arabic: index.byRef.get('87:17')!.arabic,
  english: index.byRef.get('87:17')!.english,
  confidence: 0.95, source: 'transcript-alignment' as const,
};
const merged = mergeAyahMatches([finalSegment], [], 120);
if (merged[0]?.end !== 2) throw new Error('Final Ayah incorrectly remains visible through the entire source video.');
if (toArabicIndic(31) !== '٣١') throw new Error('Arabic-Indic Ayah numbering failed.');

await Promise.all([
  fs.access(path.resolve('data/fonts/Quran-Arabic-DigitalKhatt.otf')),
  fs.access(path.resolve('data/fonts/English-Inter-Italic.ttf')),
]);
console.log(`Quran QA passed: ${index.verses.length} Ayahs, ${index.flat.length} Arabic tokens, ${index.ngrams.size} n-gram keys; timed multi-Ayah alignment works.`);
