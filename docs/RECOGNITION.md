# Quran Ayah recognition approach

The recognizer has two complementary sources:

1. **Timestamped Arabic transcription.** The inherited Gemini transcription path returns recognized Arabic words with start/end timestamps.
2. **Audio-based Ayah identification.** A second Gemini model pass listens to the audio together with the indexed timed transcript and proposes Surah/Ayah identifiers and transcript word ranges.
3. **Local Quran alignment.** All 6,236 supplied Arabic Ayahs are tokenized and normalized for diacritic/orthographic variation. Bigrams/trigrams shortlist likely Quran passages, then a bounded sequence alignment confirms the transcript words against the database.
4. **Database-only display.** Recognized references are resolved through the supplied Arabic/English data. No generated Quran Arabic or AI-written translation is rendered.

Normalization is used only to locate text. The original Arabic and translation strings are preserved for the actual video. The recognizer is designed to auto-process without a manual confirmation step, but audio recognition is probabilistic and must not be represented as infallible.
