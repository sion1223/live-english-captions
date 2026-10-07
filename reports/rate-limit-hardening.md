# Two-track API and rate-limit verification

Validated on 2026-10-08 (Asia/Seoul), version 0.5.0 / local protocol 5.

## Findings

- The prior version already separated `/asr` and `/screen`, their models and executor queues, but both used `gemini_key()` with the same saved credential.
- The local log contained repeated screen busy responses and audio timeout/reconnect messages. These logs do not establish that every audio disconnect was caused by a quota error.
- A caption translation HTTP timeout escaped its worker, terminated the healthy transcription session and triggered an audio reconnect.
- Retry handling read only the HTTP header, discarded Google's JSON `RetryInfo`, and capped delays at 60 seconds. The browser's audio reconnect also ignored server retry deadlines.

## Changes

- Keep the existing audio key and store the supplied second key as the screen credential in the per-user settings file, outside this workspace. Screen requests never fall back to the audio key. Saving either key preserves the other.
- Separate caches and cooldowns by track, model and credential. Health and logs do not expose credentials.
- Add an on-video screen ON/OFF button, preserve stored preferences, default new installations to OFF, and expose independent screen-key settings.
- Keep English passthrough and final foreign captions immediate. Coalesce interim revisions over 300 ms and space subsequent interim translations for the same segment by 800 ms. Reuse identical interim/final translations.
- Cache identical cloud requests for up to 10 minutes in bounded memory. Expose actual translation request counts, cache hits, reported tokens and 429 counts in `/health`; these token counts do not include the Live transcription stream or calculate billing charges.
- Skip small visual noise; detect local as well as full-frame changes. After empty results, reduce scans to at most one per 15 seconds. A large scene change or concentrated new text-sized change restores the configured interval. Very small changes below the heuristic threshold may be delayed or missed.
- Honor `Retry-After` and JSON `RetryInfo.retryDelay`, including long daily quota delays. With a daily quota error but no reset hint, conservatively wait 24 hours. Preserve server cooldowns across browser reconnects and screen toggles. Restarting the local server resets memory-only counters/caches/cooldowns.
- Translation timeouts and response errors remain within the translation track. Authentication/model-access failures do not repeatedly call the service with unchanged credentials.

## Verification

- Python tests cover key isolation and migration, identical-model/different-key 429 isolation, cache accounting, long quota deadlines, timeout containment, English latency, interim coalescing and final-result reuse.
- Node tests cover disabled-screen rejection, screen toggling without audio restart, reconnect deadlines, visual-noise suppression, local text changes, empty-frame pacing, stale response disposal and extension invalidation.
- Headless Edge layout check passed at desktop and mobile widths.
- The existing full browser smoke test passed against an isolated local relay on port 8766 with actual Gemini calls and both saved keys: audio startup 1,364 ms, Korean screen fixture translated to “Start the game” in approximately 2.8 seconds, observed post-transcription caption delivery 15–59 ms (three samples). This measures relay/translation delivery after ASR, not end-to-end speech latency.
- The smoke test also passed saved-key UI, screen toggle, scene cleanup, extension reload recovery, media source replacement and navigation cleanup. Its synthetic video/audio fixture does not establish long-running reliability for all YouTube streams.
- A deterministic repeated-input test makes 1 cloud call for 10 identical inputs (9 cache hits). This is not an estimate of savings for arbitrary videos.

Google rate limits are per project, not per API key. Distinct credentials alone do not prove distinct project quotas. The supplied key was successfully used for screen translation; the keys' owning project identities were not verified.

Source: [Google Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).
