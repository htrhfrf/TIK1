# Quran Video Creator

A separate full-stack project based on the supplied Content Factory codebase. It turns a Quran-recitation video link or uploaded video into one MP4 with synchronized Quran Arabic and the supplied English translation.

## What it does

1. Accepts TikTok, Instagram, YouTube, or supported direct video URLs, or a local video upload.
2. Lets you choose **Original background** or **Pure black screen**.
   - **Original:** keeps the source footage, display aspect ratio, and frame dimensions.
   - **Black:** replaces the visuals with a pure-black 1080×1920 (9:16) canvas.
   - Both modes preserve the source video's recitation audio.
3. Extracts audio and uses Gemini speech recognition for Arabic word-level transcription and timestamps.
4. Identifies the recited Surah/Ayah sequence using a second Gemini audio-identification pass plus Quran-specific sequence matching against the complete local 6,236-Ayah Arabic corpus.
5. Retrieves the Arabic verse from `data/quran/ar.json` and the English wording exclusively from `data/quran/en-mustafa-khattab-2018.json` (Mustafa Khattab 2018). AI does not generate, translate, paraphrase, or rewrite the displayed Quran text.
6. Renders one MP4. Each detected Ayah is shown with its Quranic end-of-Ayah ornament and Arabic-Indic number, with its supplied English translation underneath. Long verses wrap and dynamically scale to avoid overlap and screen clipping.

## Important accuracy note

Quran recognition is AI-assisted and corpus-checked; it cannot honestly be guaranteed flawless for every recording. Echo, background speech, partial recitations, pronunciation, unusual recitation styles, or transcription errors can affect recognition. The application does **not** ask for manual confirmation: it automatically combines timestamped transcription, a second audio-based Gemini pass, and local Arabic text alignment. When it cannot produce a usable match it stops instead of inventing a reference. Always review the final Quranic video before publishing it.

The actual Arabic and English strings displayed in the video come from the supplied databases. Normalization is used only for recognition and does not alter the stored display text. The translation file contains HTML italic tags and numeric HTML entities; the app removes the tags and decodes those entities so the visible translation reads normally, without rewriting its wording.

## Quick start

### Requirements

- Node.js 22 or newer
- Python 3.10 or newer
- A Gemini API key
- Pillow built with RAQM/HarfBuzz support (for correct connected Arabic shaping)
- FFmpeg and FFprobe (the Node dependencies include static fallbacks)
- `yt-dlp` recommended for broader social-media URL support

### Windows (PowerShell)

```powershell
Copy-Item .env.example .env
py -m pip install -r requirements.txt
npm install
```

Open `.env`, set `GEMINI_API_KEY`, then start the application:

```powershell
npm run dev
```

Open `http://localhost:3000`.

If the Python launcher is unavailable, install Python and set `PYTHON_EXECUTABLE` in `.env` to the full path of `python.exe`. Install `yt-dlp` separately (for example with `py -m pip install yt-dlp`) if you want to process TikTok/social-media links; direct video uploads do not depend on it.

### macOS / Linux

```bash
cp .env.example .env
python3 -m pip install -r requirements.txt
npm install
```

Edit `.env` to set `GEMINI_API_KEY`, then run:

```bash
npm run dev
```

Open `http://localhost:3000`. Install `yt-dlp` separately if it is not already available on your system. Set `PYTHON_EXECUTABLE` if your Python interpreter uses a different command or path.

### Docker

The included Dockerfile installs FFmpeg, FFprobe, yt-dlp, Python and the system Pillow/RAQM libraries. Build and run it with:

```bash
docker build -t quran-video-creator .
docker run --rm -p 3000:3000 -e GEMINI_API_KEY="YOUR_KEY" -v quran-projects:/app/data/projects quran-video-creator
```

Then open `http://localhost:3000`. The named volume retains completed projects between container runs.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `GEMINI_API_KEY` | Required server-side Gemini key | empty |
| `QURAN_MATCH_MODEL` | Gemini model for the second Ayah-identification pass | `gemini-flash-latest` |
| `GEMINI_TRANSCRIBE_MODEL` | Dedicated transcription model override | `gemini-3.5-transcribe` |
| `PYTHON_EXECUTABLE` | Python interpreter used for Arabic shaping | platform default (`python` / `python3`) |
| `PORT` | HTTP port | `3000` |
| `MAX_UPLOAD_MB` | Maximum upload size | `300` |
| `MAX_URL_MB` | Maximum downloaded video size | `300` |
| `MAX_VIDEO_SECONDS` | Maximum source duration | `600` |
| `ALLOW_GENERIC_URLS` | Allow supported direct-video hosts | `true` |

Keep `.env` private. Never put the Gemini API key in client-side source code. For a public deployment, put the application behind an authenticated reverse proxy and HTTPS. By default, the server listens only on `127.0.0.1` for local use; the Docker image binds inside its container.

## Output files

Each completed project contains:

- `Quran-Video.mp4` — final rendered video
- `recognized-ayahs.json` — Surah/Ayah references and display timings
- `layout-report.json` — layout fit and font-size details for the generated verses
- `arabic-transcript.txt` and `timed-words.json` — AI transcript and timing used for recognition
- `recitation.wav` and `recitation-ai.mp3` — intermediate recognition audio

Temporary Arabic PNG layers and the intermediate overlay video are removed after successful rendering.

## Rendering details

- The supplied DigitalKhatt Quran font is shaped with Pillow's RAQM/HarfBuzz engine before video composition. This avoids broken Arabic letter connections that can occur when the font is sent directly through FFmpeg/libass.
- The supplied Inter Italic font is used for the translation.
- Text is centered as one visual group, with separate wrapping and adaptive sizes for Arabic and English.
- Original mode overlays on the source frames at their original dimensions; black mode uses a pure-black 1080×1920 portrait canvas.
- The original source audio is retained and encoded as AAC in the final MP4.
- No waveform, karaoke highlighting, generated captions, or automatic social-media publishing is included.

## Validation

```bash
npm run typecheck
npm run qa:quran
npm run check
```

A full end-to-end recognition run requires a valid Gemini API key, a supported source video containing Quran recitation, and working FFmpeg/FFprobe. `yt-dlp` is needed for many social-media links; direct uploads do not depend on it. An unfinished project is marked interrupted if the server restarts while it is processing.

## Reference media

`reference/sample-videos/` contains the seven videos supplied for visual review. They are included as reference material only; they are not automatically processed when the app starts.
