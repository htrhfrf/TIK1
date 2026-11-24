# Security notes

- Keep `GEMINI_API_KEY` in the server-side `.env` only. Never expose it through Vite variables or browser code.
- The default setup is intended for localhost or a trusted private network. Do not expose it directly to the public internet; use HTTPS and an authenticated reverse proxy.
- The downloader validates external URLs and restricts unsafe/private network targets before fetching remote media. Platform download providers can change independently of this app.
- Uploaded files are stored under `data/projects/`. Do not commit this directory; it is excluded by `.gitignore`.
- The application stores generated transcripts and recognized verse references with each project. Remove project folders when those records are no longer needed.
- Quran recognition is probabilistic. The displayed Arabic and translation always come from the bundled Quran databases, but an incorrect recognition reference could still select the wrong database verse. Review the final video before sharing.
