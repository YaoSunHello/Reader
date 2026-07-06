const CDN_PDF_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
const DB_NAME = "reader-library";
const DB_VERSION = 1;
const BOOK_STORE = "books";

const state = {
  books: [],
  activeBookId: null,
  activeBook: null,
  chapters: [],
  chapterIndex: 0,
  sentenceIndex: 0,
  playbackToken: 0,
  isPlaying: false,
  isPaused: false,
  voices: []
};

const elements = {
  fileInput: document.querySelector("#fileInput"),
  libraryList: document.querySelector("#libraryList"),
  clearLibraryButton: document.querySelector("#clearLibraryButton"),
  bookMeta: document.querySelector("#bookMeta"),
  bookTitle: document.querySelector("#bookTitle"),
  chapterSelect: document.querySelector("#chapterSelect"),
  previousChapterButton: document.querySelector("#previousChapterButton"),
  nextChapterButton: document.querySelector("#nextChapterButton"),
  readerSurface: document.querySelector("#readerSurface"),
  previousSentenceButton: document.querySelector("#previousSentenceButton"),
  playButton: document.querySelector("#playButton"),
  pauseButton: document.querySelector("#pauseButton"),
  nextSentenceButton: document.querySelector("#nextSentenceButton"),
  voiceSelect: document.querySelector("#voiceSelect"),
  rateSlider: document.querySelector("#rateSlider"),
  rateValue: document.querySelector("#rateValue"),
  statusLine: document.querySelector("#statusLine"),
  busyOverlay: document.querySelector("#busyOverlay"),
  busyText: document.querySelector("#busyText")
};

if (elements.busyOverlay) {
  elements.busyOverlay.style.display = 'none';
}

class LibraryStore {
  constructor() {
    this.dbPromise = this.open();
  }

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BOOK_STORE)) {
          db.createObjectStore(BOOK_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllBooks() {
    return this.withStore("readonly", (store) => store.getAll());
  }

  async putBook(book) {
    return this.withStore("readwrite", (store) => store.put(book));
  }

  async clearBooks() {
    return this.withStore("readwrite", (store) => store.clear());
  }

  async withStore(mode, action) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(BOOK_STORE, mode);
      const store = transaction.objectStore(BOOK_STORE);
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }
}

class SpeechEngine {
  async loadVoices() {
    throw new Error("loadVoices must be implemented");
  }

  speakSentence() {
    throw new Error("speakSentence must be implemented");
  }

  pause() {}

  resume() {}

  cancel() {}
}

class WebSpeechEngine extends SpeechEngine {
  constructor() {
    super();
    this.synthesis = window.speechSynthesis;
  }

  async loadVoices() {
    if (!this.synthesis) return [];
    const existing = this.synthesis.getVoices();
    if (existing.length) return existing;
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve(this.synthesis.getVoices()), 700);
      this.synthesis.onvoiceschanged = () => {
        window.clearTimeout(timeout);
        resolve(this.synthesis.getVoices());
      };
    });
  }

  speakSentence(text, options) {
    if (!this.synthesis) {
      return Promise.reject(new Error("Web Speech API is not available in this browser."));
    }
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = options.rate;
      utterance.voice = options.voice || null;
      utterance.onend = () => resolve();
      utterance.onerror = (event) => reject(event.error || new Error("Speech synthesis failed."));
      this.synthesis.speak(utterance);
    });
  }

  pause() {
    this.synthesis?.pause();
  }

  resume() {
    this.synthesis?.resume();
  }

  cancel() {
    this.synthesis?.cancel();
  }
}

const libraryStore = new LibraryStore();
const speechEngine = new WebSpeechEngine();

async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = CDN_PDF_WORKER;
  }

  bindEvents();
  await loadVoices();
  window.speechSynthesis?.addEventListener("voiceschanged", loadVoices);
  await refreshLibrary();
  updateControls();
  setBusy(false);
}

function bindEvents() {
  elements.fileInput.addEventListener("change", handleUpload);
  elements.clearLibraryButton.addEventListener("click", clearLibrary);
  elements.chapterSelect.addEventListener("change", () => openChapter(Number(elements.chapterSelect.value), 0));
  elements.previousChapterButton.addEventListener("click", () => openChapter(state.chapterIndex - 1, 0));
  elements.nextChapterButton.addEventListener("click", () => openChapter(state.chapterIndex + 1, 0));
  elements.playButton.addEventListener("click", togglePlay);
  elements.pauseButton.addEventListener("click", togglePause);
  elements.previousSentenceButton.addEventListener("click", () => moveSentence(-1, true));
  elements.nextSentenceButton.addEventListener("click", () => moveSentence(1, true));
  elements.rateSlider.addEventListener("input", () => {
    elements.rateValue.textContent = `${Number(elements.rateSlider.value).toFixed(1)}x`;
  });
  elements.readerSurface.addEventListener("click", (event) => {
    const sentence = event.target.closest(".sentence");
    if (!sentence) return;
    setPosition(Number(sentence.dataset.chapterIndex), Number(sentence.dataset.sentenceIndex), true);
  });
}

async function loadVoices() {
  const selectedVoiceURI = state.voices[Number(elements.voiceSelect.value)]?.voiceURI;
  state.voices = await speechEngine.loadVoices();
  renderVoiceOptions(selectedVoiceURI);
}

function renderVoiceOptions(selectedVoiceURI) {
  elements.voiceSelect.replaceChildren(
    ...state.voices.map((voice, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${voice.name} (${voice.lang})`;
      option.selected = voice.voiceURI === selectedVoiceURI;
      return option;
    })
  );
  if (!state.voices.length) {
    const option = document.createElement("option");
    option.textContent = "System default";
    elements.voiceSelect.append(option);
  }
}

async function refreshLibrary() {
  state.books = (await libraryStore.getAllBooks()).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  renderLibrary();
}

function renderLibrary() {
  if (!state.books.length) {
    elements.libraryList.innerHTML = '<p class="book-meta">No saved books yet.</p>';
    return;
  }

  elements.libraryList.replaceChildren(
    ...state.books.map((book) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "library-item";
      button.setAttribute("role", "listitem");
      button.setAttribute("aria-current", String(book.id === state.activeBookId));
      button.innerHTML = `<strong></strong><span></span>`;
      button.querySelector("strong").textContent = book.title || book.name;
      button.querySelector("span").textContent = `${book.kind.toUpperCase()} - ${formatDate(book.lastOpenedAt)}`;
      button.addEventListener("click", () => openBook(book.id));
      return button;
    })
  );
}

async function handleUpload(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  const kind = detectKind(file);
  if (!kind) {
    setStatus("Use an EPUB or PDF file.");
    return;
  }

  const id = crypto.randomUUID();
  const book = {
    id,
    name: file.name,
    title: file.name.replace(/\.(epub|pdf)$/i, ""),
    kind,
    fileBlob: file,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    position: { chapterIndex: 0, sentenceIndex: 0 }
  };

  await libraryStore.putBook(book);
  await refreshLibrary();
  await openBook(id);
}

function detectKind(file) {
  const name = file.name.toLowerCase();
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) return "epub";
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  return null;
}

async function openBook(id) {
  const book = state.books.find((item) => item.id === id) || (await libraryStore.getAllBooks()).find((item) => item.id === id);
  if (!book) return;

  stopPlayback();
  state.activeBookId = id;
  state.activeBook = book;
  setBusy(true, `Extracting ${book.kind.toUpperCase()} text...`);

  try {
    const extracted = book.kind === "epub" ? await extractEpubBook(book.fileBlob) : await extractPdfBook(book.fileBlob);
    state.chapters = extracted.chapters;
    state.activeBook.title = extracted.title || book.title || book.name;
    state.activeBook.author = extracted.author || book.author || "";
    state.activeBook.lastOpenedAt = Date.now();
    state.chapterIndex = clamp(book.position?.chapterIndex || 0, 0, Math.max(0, state.chapters.length - 1));
    state.sentenceIndex = clamp(book.position?.sentenceIndex || 0, 0, Math.max(0, getCurrentSentences().length - 1));
    await saveActiveBook();
    renderLibrary();
    renderBook();
    setStatus(`${book.kind.toUpperCase()} ready.`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not load this book.");
  } finally {
    setBusy(false);
  }
}

async function extractEpubBook(blob) {
  if (!window.ePub) throw new Error("epub.js did not load.");

  const buffer = await blob.arrayBuffer();
  const book = ePub(buffer);
  await book.ready;
  const metadata = await book.loaded.metadata.catch(() => ({}));
  const navigation = await book.loaded.navigation.catch(() => ({ toc: [] }));
  const toc = flattenToc(navigation.toc || []);
  const spineItems = [];

  book.spine.each((item) => {
    if (item.linear !== "no") spineItems.push(item);
  });

  const chapters = [];
  for (const [index, item] of spineItems.entries()) {
    const doc = await item.load(book.load.bind(book));
    const text = cleanExtractedText(extractDocumentText(doc));
    item.unload();
    if (!text) continue;
    chapters.push({
      id: item.idref || `chapter-${index + 1}`,
      title: findTocTitle(item, toc) || `Chapter ${chapters.length + 1}`,
      text,
      sentences: chunkSentences(text)
    });
  }

  if (!chapters.length) throw new Error("No readable text was found in this EPUB.");
  book.destroy();
  return {
    title: metadata.title,
    author: metadata.creator,
    chapters
  };
}

function flattenToc(items, output = []) {
  for (const item of items) {
    output.push(item);
    if (item.subitems?.length) flattenToc(item.subitems, output);
  }
  return output;
}

function findTocTitle(spineItem, toc) {
  const href = normalizeHref(spineItem.href || spineItem.url || "");
  const match = toc.find((item) => {
    const tocHref = normalizeHref(item.href || "");
    return tocHref === href || tocHref.endsWith(href) || href.endsWith(tocHref);
  });
  return match?.label?.trim() || match?.title?.trim() || "";
}

function normalizeHref(href) {
  return href.split("#")[0].replace(/^.*?OPS\//, "").replace(/^\/+/, "");
}

function extractDocumentText(doc) {
  const body = doc?.body || doc?.querySelector?.("body");
  if (!body) return "";
  body.querySelectorAll("script, style, nav, aside, [aria-hidden='true']").forEach((node) => node.remove());
  return body.innerText || body.textContent || "";
}

async function extractPdfBook(blob) {
  if (!window.pdfjsLib) throw new Error("pdf.js did not load.");

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({ pageNumber, lines: groupPdfLines(content.items) });
    page.cleanup();
  }

  const cleanedPages = cleanupPdfPages(pages);
  const chapters = cleanedPages
    .filter((page) => page.text.trim())
    .map((page) => ({
      id: `page-${page.pageNumber}`,
      title: `Page ${page.pageNumber}`,
      text: page.text,
      sentences: chunkSentences(page.text)
    }));

  if (!chapters.length) throw new Error("No readable text was found in this PDF.");
  await pdf.destroy();
  return { chapters };
}

function groupPdfLines(items) {
  const positioned = items
    .map((item) => ({
      text: item.str.trim(),
      x: item.transform[4],
      y: item.transform[5]
    }))
    .filter((item) => item.text);

  positioned.sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));

  const lines = [];
  for (const item of positioned) {
    const current = lines[lines.length - 1];
    if (!current || Math.abs(current.y - item.y) > 3) {
      lines.push({ y: item.y, parts: [item] });
    } else {
      current.parts.push(item);
    }
  }

  return lines.map((line) =>
    line.parts
      .sort((a, b) => a.x - b.x)
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function cleanupPdfPages(pages) {
  const repeated = findRepeatedPdfLines(pages);
  return pages.map((page) => {
    const filteredLines = page.lines.filter((line) => {
      const normalized = normalizePdfLine(line);
      return normalized && !isPageNumberLine(line) && !repeated.has(normalized);
    });
    return {
      pageNumber: page.pageNumber,
      text: cleanupPageText(filteredLines.join("\n"))
    };
  });
}

function findRepeatedPdfLines(pages) {
  const counts = new Map();
  for (const page of pages) {
    const candidates = [...page.lines.slice(0, 2), ...page.lines.slice(-2)];
    for (const line of new Set(candidates.map(normalizePdfLine).filter(Boolean))) {
      counts.set(line, (counts.get(line) || 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.ceil(pages.length * 0.45));
  return new Set(
    [...counts.entries()]
      .filter(([line, count]) => count >= threshold && line.length > 3)
      .map(([line]) => line)
  );
}

function normalizePdfLine(line) {
  return line
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^\w# ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPageNumberLine(line) {
  return /^\s*(?:page\s*)?\d+(?:\s+of\s+\d+)?\s*$/i.test(line);
}

function cleanupPageText(text) {
  return text
    .replace(/([A-Za-z])-\s*\n\s*([A-Za-z])/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([^\n])\n(?=[^\n])/g, "$1 ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanExtractedText(text) {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function chunkSentences(text) {
  const source = text.replace(/\s+/g, " ").trim();
  if (!source) return [];

  if ("Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    return [...segmenter.segment(source)]
      .map((segment) => segment.segment.trim())
      .filter(Boolean);
  }

  return source
    .match(/[^.!?]+[.!?]+["')\]]?|.+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [source];
}

function renderBook() {
  const book = state.activeBook;
  elements.bookTitle.textContent = book?.title || book?.name || "Untitled";
  elements.bookMeta.textContent = book?.author ? `${book.kind.toUpperCase()} - ${book.author}` : book.kind.toUpperCase();
  elements.chapterSelect.replaceChildren(
    ...state.chapters.map((chapter, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = chapter.title;
      return option;
    })
  );
  renderChapter();
  updateControls();
}

function renderChapter() {
  const chapter = state.chapters[state.chapterIndex];
  if (!chapter) {
    elements.readerSurface.innerHTML = '<div class="empty-state"><p>No readable text found.</p></div>';
    return;
  }

  elements.chapterSelect.value = String(state.chapterIndex);
  const title = document.createElement("h3");
  title.className = "chapter-title";
  title.textContent = chapter.title;

  const flow = document.createElement("article");
  flow.className = "text-flow";
  chapter.sentences.forEach((sentence, index) => {
    const span = document.createElement("span");
    span.className = "sentence";
    span.dataset.chapterIndex = String(state.chapterIndex);
    span.dataset.sentenceIndex = String(index);
    span.textContent = sentence;
    flow.append(span, " ");
  });

  elements.readerSurface.replaceChildren(title, flow);
  highlightCurrentSentence(false);
}

function highlightCurrentSentence(scroll = true) {
  elements.readerSurface.querySelectorAll(".sentence.current").forEach((node) => node.classList.remove("current"));
  const selector = `.sentence[data-chapter-index="${state.chapterIndex}"][data-sentence-index="${state.sentenceIndex}"]`;
  const current = elements.readerSurface.querySelector(selector);
  if (current) {
    current.classList.add("current");
    if (scroll) current.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

async function togglePlay() {
  if (state.isPaused) {
    speechEngine.resume();
    state.isPaused = false;
    state.isPlaying = true;
    updateControls();
    return;
  }
  if (state.isPlaying) return;
  await playFromCurrent();
}

function togglePause() {
  if (!state.isPlaying) return;
  if (state.isPaused) {
    speechEngine.resume();
    state.isPaused = false;
  } else {
    speechEngine.pause();
    state.isPaused = true;
  }
  updateControls();
}

async function playFromCurrent() {
  if (!state.chapters.length) return;

  const token = ++state.playbackToken;
  state.isPlaying = true;
  state.isPaused = false;
  updateControls();

  while (state.playbackToken === token && state.chapterIndex < state.chapters.length) {
    const sentence = getCurrentSentences()[state.sentenceIndex];
    if (!sentence) {
      if (!advancePosition()) break;
      continue;
    }

    highlightCurrentSentence(true);
    await saveActiveBook();
    try {
      await speechEngine.speakSentence(sentence, {
        voice: state.voices[Number(elements.voiceSelect.value)] || null,
        rate: Number(elements.rateSlider.value)
      });
    } catch (error) {
      if (state.playbackToken === token) setStatus(String(error));
      break;
    }

    if (state.playbackToken !== token) break;
    if (!advancePosition()) break;
  }

  if (state.playbackToken === token) {
    state.isPlaying = false;
    state.isPaused = false;
    updateControls();
    await saveActiveBook();
  }
}

function stopPlayback() {
  state.playbackToken += 1;
  state.isPlaying = false;
  state.isPaused = false;
  speechEngine.cancel();
  updateControls();
}

async function moveSentence(delta, restartPlayback) {
  if (!state.chapters.length) return;
  const wasPlaying = state.isPlaying && !state.isPaused;
  stopPlayback();

  if (delta > 0) {
    advancePosition();
  } else {
    retreatPosition();
  }

  renderChapterIfNeeded();
  highlightCurrentSentence(true);
  await saveActiveBook();
  if (restartPlayback && wasPlaying) playFromCurrent();
}

function advancePosition() {
  const sentences = getCurrentSentences();
  if (state.sentenceIndex < sentences.length - 1) {
    state.sentenceIndex += 1;
    return true;
  }
  if (state.chapterIndex < state.chapters.length - 1) {
    state.chapterIndex += 1;
    state.sentenceIndex = 0;
    renderChapter();
    return true;
  }
  return false;
}

function retreatPosition() {
  if (state.sentenceIndex > 0) {
    state.sentenceIndex -= 1;
    return true;
  }
  if (state.chapterIndex > 0) {
    state.chapterIndex -= 1;
    state.sentenceIndex = Math.max(0, getCurrentSentences().length - 1);
    renderChapter();
    return true;
  }
  return false;
}

function renderChapterIfNeeded() {
  if (elements.chapterSelect.value !== String(state.chapterIndex)) renderChapter();
}

function openChapter(chapterIndex, sentenceIndex = 0) {
  if (!state.chapters.length) return;
  stopPlayback();
  state.chapterIndex = clamp(chapterIndex, 0, state.chapters.length - 1);
  state.sentenceIndex = clamp(sentenceIndex, 0, Math.max(0, getCurrentSentences().length - 1));
  renderChapter();
  saveActiveBook();
  updateControls();
}

function setPosition(chapterIndex, sentenceIndex, save) {
  stopPlayback();
  state.chapterIndex = chapterIndex;
  state.sentenceIndex = sentenceIndex;
  highlightCurrentSentence(true);
  if (save) saveActiveBook();
}

function getCurrentSentences() {
  return state.chapters[state.chapterIndex]?.sentences || [];
}

async function saveActiveBook() {
  if (!state.activeBook) return;
  state.activeBook.position = {
    chapterIndex: state.chapterIndex,
    sentenceIndex: state.sentenceIndex
  };
  state.activeBook.lastOpenedAt = Date.now();
  await libraryStore.putBook(state.activeBook);
  state.books = state.books.map((book) => (book.id === state.activeBook.id ? state.activeBook : book));
}

async function clearLibrary() {
  stopPlayback();
  await libraryStore.clearBooks();
  state.books = [];
  state.activeBook = null;
  state.activeBookId = null;
  state.chapters = [];
  elements.bookMeta.textContent = "No book loaded";
  elements.bookTitle.textContent = "Upload an EPUB or PDF to begin";
  elements.chapterSelect.replaceChildren();
  elements.readerSurface.innerHTML = '<div class="empty-state"><p>Upload a book from the left panel. Files stay in this browser.</p></div>';
  renderLibrary();
  updateControls();
}

function updateControls() {
  const hasBook = Boolean(state.chapters.length);
  elements.previousChapterButton.disabled = !hasBook || state.chapterIndex <= 0;
  elements.nextChapterButton.disabled = !hasBook || state.chapterIndex >= state.chapters.length - 1;
  elements.chapterSelect.disabled = !hasBook;
  elements.previousSentenceButton.disabled = !hasBook;
  elements.nextSentenceButton.disabled = !hasBook;
  elements.playButton.disabled = !hasBook;
  elements.pauseButton.disabled = !hasBook || !state.isPlaying;
  elements.playButton.textContent = state.isPaused ? "Resume" : "Play";
  elements.pauseButton.textContent = state.isPaused ? "Resume" : "Pause";
}

function setBusy(isBusy, text = "Processing book...") {
  if (!elements.busyOverlay) return;
  elements.busyOverlay.style.display = isBusy ? 'grid' : 'none';
  if (isBusy) {
    elements.busyText.textContent = text;
  }
}

function setStatus(text) {
  elements.statusLine.textContent = text;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

init();
