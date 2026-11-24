import type { Project } from '../types';
async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status}).`);
  return body as T;
}
export async function listProjects() { return readJson<Project[]>(await fetch('/api/projects')); }
export async function getProject(id: string) { return readJson<Project>(await fetch(`/api/projects/${encodeURIComponent(id)}`)); }
export async function createProject(file: File | null, url: string, backgroundMode: 'original' | 'black') {
  const form = new FormData();
  if (file) form.append('video', file);
  if (url.trim()) form.append('url', url.trim());
  form.append('backgroundMode', backgroundMode);
  return readJson<Project>(await fetch('/api/projects', { method: 'POST', body: form }));
}
export async function cancelProject(id: string) { return readJson<Project>(await fetch(`/api/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST' })); }
export async function deleteProject(id: string) { return readJson<{ok: boolean}>(await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })); }
export async function getHealth() { return readJson<{ok:boolean;geminiConfigured:boolean;quranAyahs:number}>(await fetch('/api/health')); }
