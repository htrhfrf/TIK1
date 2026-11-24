import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cancelProject, createProject, deleteProject, getHealth, getProject, listProjects } from './lib/api';
import type { Project } from './types';

function formatDuration(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return '—';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function formatDate(value: string) {
  try { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return value; }
}
function formatBytes(bytes?: number) { return bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : ''; }

export default function App() {
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [backgroundMode, setBackgroundMode] = useState<'original' | 'black'>('original');
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{type:'error'|'success'|'info';text:string}|null>(null);
  const [health, setHealth] = useState<{ok:boolean;geminiConfigured:boolean;quranAyahs:number}|null>(null);
  const [dragging, setDragging] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([listProjects(), getHealth()]).then(([items, status]) => {
      setProjects(items); setHealth(status);
      const latest = items.find((item) => item.status === 'processing' || item.status === 'queued') || items[0];
      if (latest) setActiveProject(latest);
    }).catch((error) => setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not load the application.' }));
  }, []);

  useEffect(() => {
    if (!activeProject || !['queued', 'processing'].includes(activeProject.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updated = await getProject(activeProject.id);
        if (stopped) return;
        setActiveProject(updated);
        setProjects((items) => [updated, ...items.filter((x) => x.id !== updated.id)]);
        if (updated.status === 'complete') setNotice({ type: 'success', text: 'Your Quran video is ready.' });
        if (updated.status === 'error') setNotice({ type: 'error', text: updated.error || 'Video processing failed.' });
      } catch (error) {
        if (!stopped) setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not refresh processing status.' });
      }
      if (!stopped && ['queued', 'processing'].includes(activeProject.status)) timer = setTimeout(poll, 1600);
    };
    timer = setTimeout(poll, 1100);
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeProject?.id, activeProject?.status]);

  const isProcessing = activeProject?.status === 'processing' || activeProject?.status === 'queued';
  const canStart = !busy && !isProcessing && (Boolean(file) || Boolean(url.trim()));
  const completedCount = useMemo(() => projects.filter((p) => p.status === 'complete').length, [projects]);

  async function startCreation(event?: React.FormEvent) {
    event?.preventDefault();
    if (!file && !url.trim()) { setNotice({ type: 'error', text: 'Paste a video link or choose a video file first.' }); return; }
    setBusy(true); setNotice(null);
    try {
      const created = await createProject(file, file ? '' : url, backgroundMode);
      setActiveProject(created); setProjects((items) => [created, ...items.filter((x) => x.id !== created.id)]);
      setUrl(''); setFile(null); if (fileInput.current) fileInput.current.value = ''; setShowDetails(false);
    } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not start video creation.' }); }
    finally { setBusy(false); }
  }
  async function stopJob() {
    if (!activeProject) return;
    try {
      const updated = await cancelProject(activeProject.id); setActiveProject(updated);
      setProjects((items) => [updated, ...items.filter((x) => x.id !== updated.id)]);
      setNotice({ type: 'info', text: 'Processing was cancelled.' });
    } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not cancel processing.' }); }
  }
  async function removeProject(project: Project) {
    try {
      await deleteProject(project.id); setProjects((items) => items.filter((item) => item.id !== project.id));
      if (activeProject?.id === project.id) setActiveProject(null);
    } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not delete this project.' }); }
  }
  function selectFile(nextFile?: File) {
    if (!nextFile) return;
    if (!/^video\//.test(nextFile.type) && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(nextFile.name)) {
      setNotice({ type: 'error', text: 'Choose a supported video file (MP4, MOV, M4V, WebM, MKV or AVI).' }); return;
    }
    setFile(nextFile); setUrl(''); setNotice(null);
  }

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Quran Video Creator home"><span className="brand-mark">۞</span><span><strong>QURAN</strong><small>VIDEO CREATOR</small></span></a>
      <div className="topbar-right"><span className="header-chip"><span className="live-dot"/> AI-POWERED VERSE RECOGNITION</span><a className="top-link" href="#workflow">How it works <span>↗</span></a></div>
    </header>

    <main id="top" className="main-wrap">
      <section className="hero-section">
        <div className="eyebrow"><span className="eyebrow-line"/> QURAN RECITATION · VIDEO PRODUCTION</div>
        <h1>Let the verses<br/><em>find their place.</em></h1>
        <p className="hero-copy">Turn a Quran recitation into a beautifully composed video. The Arabic Ayahs and their exact supplied English translation appear in sync with the recitation.</p>
        <div className="hero-features"><span><b>01</b> Detect the Ayah</span><span><b>02</b> Match the Quran text</span><span><b>03</b> Render your video</span></div>
      </section>

      <section className="creator-card" aria-label="Create a Quran video">
        <div className="card-heading"><div><div className="section-kicker">NEW PROJECT</div><h2>Create your video</h2></div><div className="database-status"><span className="status-dot"/>{health?.quranAyahs ? `${health.quranAyahs.toLocaleString()} Ayahs loaded` : 'Quran database'}</div></div>
        {health && !health.geminiConfigured && <div className="notice info" role="status"><span>i</span> Add your Gemini API key to the server-side <code>.env</code> file as <code>GEMINI_API_KEY</code>, then restart the application before processing a video.</div>}
        <form onSubmit={startCreation}>
          <div className="field-label-row"><label htmlFor="video-url">VIDEO LINK</label><span>OR UPLOAD A FILE</span></div>
          <div className="url-input-wrap"><span className="url-icon">↗</span><input id="video-url" type="url" value={url} onChange={(e) => { setUrl(e.target.value); if (e.target.value) { setFile(null); if (fileInput.current) fileInput.current.value = ''; } }} placeholder="Paste a TikTok, Instagram, YouTube or video link..." disabled={Boolean(file) || busy || isProcessing}/><button type="button" className="upload-trigger" onClick={() => fileInput.current?.click()} disabled={busy || isProcessing}>Upload video <span>＋</span></button><input ref={fileInput} type="file" accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" hidden onChange={(e) => selectFile(e.target.files?.[0])}/></div>
          {file && <div className="selected-file"><span className="file-icon">▣</span><span>{file.name}</span><small>{formatBytes(file.size)}</small><button type="button" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; }}>×</button></div>}
          <div className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`} onDragOver={(e) => {e.preventDefault(); setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={(e) => {e.preventDefault(); setDragging(false); selectFile(e.dataTransfer.files?.[0]);}}><span className="drop-icon">⇧</span><span>Drag and drop a video here <small>MP4, MOV, WebM and more</small></span></div>

          <div className="choice-heading"><div><label>CHOOSE YOUR BACKGROUND</label><p>Both options keep the original Quran recitation audio.</p></div><span className="step-number">01 / 02</span></div>
          <div className="background-options" role="radiogroup" aria-label="Video background">
            <button type="button" role="radio" aria-checked={backgroundMode === 'original'} className={`background-option ${backgroundMode === 'original' ? 'selected' : ''}`} onClick={() => setBackgroundMode('original')}><span className="option-preview original-preview"><span className="mini-scene"><i></i><i></i><i></i></span><span className="mini-arabic">ٱلْحَمْدُ لِلَّٰهِ</span><span className="mini-english">All praise is for Allah</span></span><span className="option-copy"><strong>Original background</strong><small>Keep the source video exactly as it is. Preserve its original aspect ratio and dimensions.</small><span className="option-meta">SOURCE DIMENSIONS <b>↗</b></span></span><span className="radio-indicator"/></button>
            <button type="button" role="radio" aria-checked={backgroundMode === 'black'} className={`background-option ${backgroundMode === 'black' ? 'selected' : ''}`} onClick={() => setBackgroundMode('black')}><span className="option-preview black-preview"><span className="mini-arabic">ٱلْحَمْدُ لِلَّٰهِ</span><span className="mini-english">All praise is for Allah</span></span><span className="option-copy"><strong>Pure black screen</strong><small>Minimal, distraction-free Quran layout with a vertical 9:16 canvas.</small><span className="option-meta">1080 × 1920 · 9:16 <b>↗</b></span></span><span className="radio-indicator"/></button>
          </div>

          <div className="settings-note"><span className="note-icon">✦</span><p><strong>Exact Quran text, not AI-generated text.</strong> Verse wording is taken from your Arabic Quran database and the Mustafa Khattab 2018 translation file without rewriting.</p></div>
          {notice && <div className={`notice ${notice.type}`} role="status"><span>{notice.type === 'error' ? '!' : notice.type === 'success' ? '✓' : 'i'}</span>{notice.text}<button type="button" onClick={() => setNotice(null)}>×</button></div>}
          <button type="submit" className="create-button" disabled={!canStart}>{busy ? <><span className="spinner"/> Starting project…</> : isProcessing ? 'Processing in progress' : <>Create Quran video <span>→</span></>}</button>
          <div className="privacy-line"><span>♧</span> Processing runs on your server. Your Gemini API key stays private.</div>
        </form>
      </section>

      {activeProject && <section className="result-section" aria-live="polite">
        <div className="result-heading"><div><div className="section-kicker">PROJECT STATUS</div><h2>{activeProject.status === 'complete' ? 'Your video is ready' : activeProject.status === 'error' ? 'Processing needs attention' : activeProject.status === 'cancelled' ? 'Project cancelled' : 'Creating your Quran video'}</h2></div><span className={`status-pill ${activeProject.status}`}>{activeProject.status === 'complete' ? 'COMPLETE' : activeProject.status.toUpperCase()}</span></div>
        <div className="progress-card"><div className="progress-meta"><span>{activeProject.stage}</span><strong>{activeProject.progress}%</strong></div><div className="progress-track"><span style={{ width: `${activeProject.progress}%` }}/></div>{isProcessing && <div className="progress-foot"><span className="spinner small"/> Your recitation is being analyzed and aligned automatically. <button type="button" onClick={stopJob}>Cancel</button></div>}{activeProject.error && <p className="error-copy">{activeProject.error}</p>}</div>
        {activeProject.status === 'complete' && activeProject.outputUrl && <div className="video-result-card">
          <div className="video-result-top"><div><strong>Quran-Video.mp4</strong><small>{activeProject.outputWidth} × {activeProject.outputHeight} · {formatDuration(activeProject.duration)} · {activeProject.backgroundMode === 'original' ? 'Original background' : 'Black 9:16'}</small></div><a className="download-button" href={activeProject.outputUrl} download="Quran-Video.mp4">Download MP4 <span>↓</span></a></div>
          <video className="video-preview" controls playsInline src={activeProject.outputUrl}/>
          <div className="verse-summary"><div><b>{activeProject.recognizedAyahs?.length || 0}</b><span>Ayah occurrences detected</span></div><div><b>{new Set(activeProject.recognizedAyahs?.map((x) => x.surah) || []).size}</b><span>Surahs identified</span></div><button type="button" className="text-button" onClick={() => setShowDetails((v) => !v)}>{showDetails ? 'Hide' : 'View'} detected verses <span>{showDetails ? '−' : '+'}</span></button></div>
          {showDetails && <div className="verse-list">{(activeProject.recognizedAyahs || []).map((item, i) => <div className="verse-row" key={item.id}><span className="verse-index">{String(i + 1).padStart(2, '0')}</span><span className="verse-ref">{item.surah}:{item.ayah}</span><span className="verse-arabic" dir="rtl">{item.arabic}</span><span className="verse-timing">{formatDuration(item.start)}</span></div>)}</div>}
        </div>}
        <div className="log-toggle"><details><summary>Processing log</summary><div className="log-entries">{activeProject.logs.map((line, i) => <p key={i}>{line}</p>)}</div></details></div>
      </section>}

      <section className="workflow-section" id="workflow"><div className="section-kicker">THE PROCESS</div><h2>From recitation to verse-perfect video.</h2><div className="workflow-grid"><article><span className="workflow-no">01</span><div className="workflow-icon">↗</div><h3>Send a video</h3><p>Paste a social-media link or upload the recitation video you want to use.</p></article><article><span className="workflow-no">02</span><div className="workflow-icon">۞</div><h3>Recognize the Ayahs</h3><p>AI transcribes the Arabic recitation, identifies the Surah and Ayah sequence, and aligns each verse to its timing.</p></article><article><span className="workflow-no">03</span><div className="workflow-icon">▤</div><h3>Render and download</h3><p>The exact Arabic verse, ornate Ayah number and supplied English translation appear together in a clean layout.</p></article></div></section>

      {projects.length > 0 && <section className="history-section"><div className="history-heading"><div><div className="section-kicker">YOUR WORKSPACE</div><h2>Recent projects</h2></div><span>{completedCount} completed</span></div><div className="history-list">{projects.slice(0, 5).map((project) => <button key={project.id} className={`history-item ${activeProject?.id === project.id ? 'active' : ''}`} onClick={() => {setActiveProject(project); setShowDetails(false);}}><span className="history-icon">{project.status === 'complete' ? '✓' : project.status === 'error' ? '!' : '◌'}</span><span className="history-copy"><strong>{project.sourceName}</strong><small>{formatDate(project.createdAt)} · {project.backgroundMode === 'original' ? 'Original' : 'Black screen'}</small></span><span className={`history-status ${project.status}`}>{project.status}</span>{['error','cancelled','complete'].includes(project.status) && <span className="history-delete" onClick={(e) => {e.stopPropagation(); void removeProject(project);}}>×</span>}</button>)}</div></section>}
    </main>

    <footer className="footer"><div className="footer-brand"><span>۞</span> QURAN VIDEO CREATOR</div><p>Arabic and English wording is sourced from the Quran files supplied with this project.</p><div className="footer-right">Built for clarity. Made with care.</div></footer>
  </div>;
}
