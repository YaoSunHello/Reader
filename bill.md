# AWS Polly Billing Workflow

Reader uses AWS Polly only when it needs to synthesize new audio. The app now checks two caches before making a billable AWS request.

## Request Flow

1. The user clicks `Read aloud`.
2. The app reads the book one sentence at a time.
3. For each sentence, the browser checks its local IndexedDB audio cache.
4. If the sentence audio is found locally, it plays from the browser cache and does not call AWS.
5. If the browser cache misses, the app sends the sentence to `POST /api/speak`.
6. The backend checks the server MP3 cache in `POLLY_CACHE_DIR`, which defaults to `/tmp/reader-polly-cache`.
7. If the server cache has the MP3, it returns that file and does not call AWS.
8. Only when both caches miss does the backend call `polly.synthesize_speech(...)`.
9. That AWS Polly synthesis call is the billable event.
10. The returned MP3 is saved into the server cache and browser cache for future reuse.

## Billing Impact

- The default Polly voice is `Joanna`.
- The default Polly engine is `standard`.
- The output format is `mp3`.
- Standard Polly is billed by characters synthesized, roughly `$4 per 1 million characters` after the free tier.
- Replaying the same cached sentence should not create another Polly charge.

## Cost-Saving Notes

- Repeated playback is cheap because cached MP3 audio is reused.
- A new charge happens when the app sees new text, a changed voice, a changed engine, or cleared/missing caches.
- The browser cache is capped at `150 MB` or `2000` audio items.
- The server cache defaults to `/tmp/reader-polly-cache`; some hosts wipe `/tmp` during restart or redeploy.
- For the best long-term savings, configure `POLLY_CACHE_DIR` to persistent storage if the hosting platform supports it.
