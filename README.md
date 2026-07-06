# reader

A client-side PWA for uploading EPUB or PDF files, extracting readable text, and reading it aloud with the Web Speech API.

## Run

```sh
python3 -m http.server 4177
```

Open `http://127.0.0.1:4177`.

## Notes

- EPUB extraction uses `epub.js` and exposes chapter navigation from the EPUB spine/table of contents.
- PDF extraction uses `pdf.js`, strips repeated top/bottom lines, removes simple page numbers, and rejoins hyphenated line breaks.
- Books and reading position are stored in IndexedDB. Files stay in the browser.
- Speech is routed through a `SpeechEngine` interface. `WebSpeechEngine` is the current implementation and can be replaced or extended with cloud TTS later.
