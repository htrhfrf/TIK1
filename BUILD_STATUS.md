# Build and validation status

## Verified in the supplied build environment

- The Arabic and English source files contain all 114 Surahs and all 6,236 paired Ayahs.
- The Quran index loads 77,429 normalized Arabic tokens and its n-gram search index.
- Automated timed-alignment checks identify a synthetic multi-Ayah passage in the correct order.
- The supplied Arabic font renders with connected Arabic shaping through Pillow RAQM/HarfBuzz.
- Black-mode render test: H.264 video at 1080×1920 with an AAC audio stream.
- Original-mode render test: H.264 video at the source's 1280×960 dimensions with an AAC audio stream.
- Long-Ayah layout test: 2:282 wraps and scales to fit a 1280×960 frame without text overlap or clipping.
- Python renderer compiles, and all 16 TypeScript/TSX source files pass TypeScript's syntax transpilation check.

## Not verified here

- Installing Node dependencies and running the full Vite/TypeScript build could not be completed because the package registry was unreachable from the build environment (`EAI_AGAIN` resolving `registry.npmjs.org`). The project includes its package manifest; run `npm install` followed by `npm run check` on a machine with registry access.
- A live Gemini end-to-end recognition job was not run because it requires your own `GEMINI_API_KEY` and a live API connection. A valid key is required for video processing.
- TikTok and other social-media download providers can change independently. `yt-dlp` should be kept updated; direct video uploads are available as an alternative.

Quran recognition is automated and uses both AI recognition and local Quran-corpus alignment, but no speech-recognition system can guarantee a correct match for every recording. Review the final video before publishing.
