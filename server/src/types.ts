export type ProjectStatus = 'queued' | 'processing' | 'complete' | 'error' | 'cancelled' | 'interrupted';
export type TranslationMode = 'faithful' | 'natural' | 'literal' | 'cinematic';
export type VerificationStatus = 'verified' | 'local' | 'failed' | 'pending';

export interface TimedWord {
  index: number;
  text: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: string;
  wordStart: number;
  wordEnd: number;
  start: number;
  end: number;
  arabic: string;
  english?: string;
}

export interface TranslationSegment {
  id: string;
  wordStart: number;
  wordEnd: number;
  english: string;
  start?: number;
  end?: number;
}

export interface TimedSegment {
  id?: string;
  start: number;
  end: number;
  text: string;
  sourceText?: string;
  wordStart?: number;
  wordEnd?: number;
}

export interface TranslationQa {
  status: VerificationStatus;
  provider?: string;
  model?: string;
  checks: Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
  warnings: string[];
  verifiedAt?: string;
}

export interface ModelMetric {
  model: string;
  attempts: number;
  successes: number;
  failures: number;
  timeouts: number;
  rate429: number;
  rate503: number;
  lastLatencyMs?: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  lastSuccessAt?: number;
  cooldownUntil?: number;
  lastError?: string;
  lastStatus?: number;
}

export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Preset {
  id: number;
  name: string;
  width: number;
  height: number;
  fontName: string;
  fontFileName?: string;
  fontPath?: string;
  fontSize: number;
  uiTextSize?: number;
  fontItalic?: boolean;
  textColor: string;
  outlineColor: string;
  outlineWidth: number;
  align: 'left' | 'center' | 'right';
  vertical: 'top' | 'middle' | 'bottom';
  marginX: number;
  marginY: number;
  maxLineChars: number;
  maxTextWidth: number;
  lineSpacing: number;
  safeArea: SafeArea;
  captionBottomOffset?: number;
  shadow?: number;
  videoFit?: 'cover' | 'contain';
}

export interface GlossaryTerm {
  source: string;
  preferred: string;
  forbidden?: string[];
}

export interface Settings {
  version: number;
  translationMode: TranslationMode;
  sourceLanguage: string;
  targetLanguage: string;
  glossary: GlossaryTerm[];
  presets: Preset[];
  retentionDays: number;
  uploadRetentionHours: number;
  visualTheme?: string;
  showWaveform?: boolean;
  karaokeSubtitles?: boolean;
}

export interface ProjectOutput {
  page: number;
  name: string;
  url: string;
  bytes: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

export interface ProjectState {
  id: string;
  name: string;
  status: ProjectStatus;
  stage: string;
  stageKey?: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  sourceName?: string;
  sourcePath?: string;
  sourceUrl?: string;
  sourcePreviewUrl?: string;
  inputMime?: string;
  duration?: number;
  language?: string;
  transcript?: string;
  transcriptWords?: TimedWord[];
  subtitleSegments?: TimedSegment[];
  waveform?: number[];
  translationProvider?: string;
  translationModel?: string;
  qa?: TranslationQa;
  outputs?: ProjectOutput[];
  srtUrl?: string;
  transcriptUrl?: string;
  packageUrl?: string;
  socialCaption?: string;
  visualTheme?: string;
  showWaveform?: boolean;
  karaokeSubtitles?: boolean;
  error?: string;
  logs: string[];
  cancelled?: boolean;
  resumable?: boolean;
  inputRetained?: boolean;
  completedStages?: string[];
}
