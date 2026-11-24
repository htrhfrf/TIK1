export interface AyahSegment {
  id: string; surah: number; ayah: number; start: number; end: number;
  arabic: string; english: string; confidence: number;
  source: 'transcript-alignment' | 'gemini-audio';
}
export interface Project {
  id: string; name: string;
  status: 'queued' | 'processing' | 'complete' | 'error' | 'cancelled';
  stage: string; progress: number; createdAt: string; updatedAt: string;
  sourceName: string; backgroundMode: 'original' | 'black';
  sourceWidth?: number; sourceHeight?: number; outputWidth?: number; outputHeight?: number;
  duration?: number; recognizedAyahs?: AyahSegment[]; outputUrl?: string; error?: string; logs: string[];
}
