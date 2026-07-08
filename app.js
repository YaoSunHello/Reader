const CDN_PDF_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
const DB_NAME = "reader-library";
const DB_VERSION = 3;
const BOOK_STORE = "books";
const AUDIO_STORE = "pollyAudio";
const APP_STATE_STORE = "appState";
const READ_HISTORY_STORE = "readHistory";
const AUDIO_CACHE_MAX_BYTES = 200 * 1024 * 1024;
const AUDIO_CACHE_MAX_ITEMS = 2000;
const LAST_ACTIVE_BOOK_KEY = "lastActiveBookId";
const DEBUG_TTS = isDebugTtsEnabled();
const PLAYBACK_RUNTIME_STORAGE_KEYS = [
  "intentStopped",
  "isPlaying",
  "isPaused",
  "chunks",
  "speechQueue",
  "utterance",
  "currentUtterance"
];

function isDebugTtsEnabled() {
  try {
    return localStorage.getItem("DEBUG_TTS") === "1" || globalThis.DEBUG_TTS === true;
  } catch {
    return globalThis.DEBUG_TTS === true;
  }
}

const state = {
  books: [],
  activeBookId: null,
  activeBook: null,
  chapters: [],
  speechQueue: [],
  currentChunkIndex: 0,
  chapterIndex: 0,
  sentenceIndex: 0,
  playbackToken: 0,
  isPlaying: false,
  isPaused: false,
  voices: []
};

const ttsControl = {
  pending: false,
  pendingTimer: 0,
  lastButtonPressAt: 0,
  intent: "idle",
  intentStopped: false,
  watchdogId: 0
};

const currentUtteranceRef = {
  current: null
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
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          const audioStore = db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
          audioStore.createIndex("lastUsedAt", "lastUsedAt");
        }
        if (!db.objectStoreNames.contains(APP_STATE_STORE)) {
          db.createObjectStore(APP_STATE_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(READ_HISTORY_STORE)) {
          const readHistoryStore = db.createObjectStore(READ_HISTORY_STORE, { keyPath: "id" });
          readHistoryStore.createIndex("bookId", "bookId");
          readHistoryStore.createIndex("readAt", "readAt");
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

  async getAppState(key) {
    const entry = await this.withNamedStore(APP_STATE_STORE, "readonly", (store) => store.get(key));
    return entry?.value;
  }

  async setAppState(key, value) {
    return this.withNamedStore(APP_STATE_STORE, "readwrite", (store) => store.put({ key, value }));
  }

  async clearAppState() {
    return this.withNamedStore(APP_STATE_STORE, "readwrite", (store) => store.clear());
  }

  async getCachedAudio(id) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, "readwrite");
      const store = transaction.objectStore(AUDIO_STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const entry = request.result;
        if (!entry) {
          resolve(null);
          return;
        }
        entry.lastUsedAt = Date.now();
        store.put(entry);
        resolve(entry.blob);
      };
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async putCachedAudio(id, blob) {
    const db = await this.dbPromise;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, "readwrite");
      const store = transaction.objectStore(AUDIO_STORE);
      store.put({
        id,
        blob,
        size: blob.size,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    this.trimAudioCache().catch(() => {});
  }

  async deleteCachedAudio(id) {
    return this.withNamedStore(AUDIO_STORE, "readwrite", (store) => store.delete(id));
  }

  async markSentenceRead(bookId, chapterIndex, sentenceIndex, text, audioCacheKey) {
    if (!bookId || !text) return;
    return this.withNamedStore(READ_HISTORY_STORE, "readwrite", (store) => store.put({
      id: `${bookId}:${chapterIndex}:${sentenceIndex}`,
      bookId,
      chapterIndex,
      sentenceIndex,
      text,
      audioCacheKey,
      readAt: Date.now()
    }));
  }

  async trimAudioCache() {
    const db = await this.dbPromise;
    const entries = await new Promise((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, "readonly");
      const request = transaction.objectStore(AUDIO_STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    let totalBytes = entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
    const oldestFirst = entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const idsToDelete = [];
    while ((totalBytes > AUDIO_CACHE_MAX_BYTES || oldestFirst.length - idsToDelete.length > AUDIO_CACHE_MAX_ITEMS) && oldestFirst.length) {
      const entry = oldestFirst.shift();
      idsToDelete.push(entry.id);
      totalBytes -= entry.size || 0;
    }
    if (!idsToDelete.length) return;

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, "readwrite");
      const store = transaction.objectStore(AUDIO_STORE);
      idsToDelete.forEach((id) => store.delete(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async withStore(mode, action) {
    return this.withNamedStore(BOOK_STORE, mode, action);
  }

  async withNamedStore(storeName, mode, action) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
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

  continuePlayback() {}

  setRate() {}

  cancel() {}

  getPlaybackState() {
    return { mode: "idle", speaking: false, paused: false, pending: false };
  }
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
    if (typeof options.shouldContinue === "function" && !options.shouldContinue()) {
      return Promise.reject(new Error("Playback cancelled."));
    }
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = options.rate;
      utterance.voice = options.voice || null;
      utterance.onstart = () => {
        clearTtsPending("onstart");
        if (options.onStart) {
          options.onStart();
        } else {
          logTtsState("onstart");
        }
      };
      utterance.onend = async (event) => {
        try {
          await options.onEnd?.(event);
          if (currentUtteranceRef.current === utterance) currentUtteranceRef.current = null;
          resolve();
        } catch (error) {
          if (currentUtteranceRef.current === utterance) currentUtteranceRef.current = null;
          reject(error);
        }
      };
      utterance.onerror = (event) => {
        options.onError?.(event);
        if (!options.onError) {
          logTtsState("onerror", { error: event });
        }
        if (currentUtteranceRef.current === utterance) currentUtteranceRef.current = null;
        clearTtsPending("onerror");
        reject(event.error || new Error("Speech synthesis failed."));
      };
      currentUtteranceRef.current = utterance;
      this.synthesis.speak(utterance);
    });
  }

  pause() {
    this.synthesis?.pause();
  }

  continuePlayback() {
    this.synthesis?.resume();
  }

  async cancel() {
    await resetSpeech("web speech cancel");
  }

  getPlaybackState() {
    const status = getSpeechSynthesisState();
    return {
      mode: status.paused ? "paused" : status.speaking || status.queuePending ? "speaking" : "idle",
      speaking: status.speaking,
      paused: status.paused,
      pending: status.queuePending
    };
  }
}

class PollyEngine extends SpeechEngine {
  constructor(audioCache, fallbackEngine) {
    super();
    this.audioCache = audioCache;
    this.fallbackEngine = fallbackEngine;
    this.currentAudio = document.createElement("audio");
    this.currentAudio.preload = "auto";
    this.currentAudio.setAttribute("playsinline", "");
    this.currentAudio.style.display = "none";
    this.currentObjectUrl = "";
    this.currentReject = null;
    this.isPausedManually = false;
    this.useFallbackOnly = false;
    this.loadingAudioCount = 0;
    document.body.append(this.currentAudio);
  }

  async loadVoices() {
    return [{ name: "AWS Polly (Joanna)", voiceURI: "polly-joanna", lang: "en-US" }];
  }

  async speakSentence(text, options) {
    if (this.useFallbackOnly && this.fallbackEngine) {
      await this.fallbackEngine.speakSentence(text, { ...options, voice: null });
      return;
    }

    const cacheKey = await this.cacheKey(text, options);
    try {
      const blob = await this.loadAudioBlob(text, cacheKey, false);
      if (typeof options.shouldContinue === "function" && !options.shouldContinue()) {
        throw new Error("Playback cancelled.");
      }
      await this.playBlob(blob, options);
      return;
    } catch (error) {
      if (error?.message === "Playback cancelled.") throw error;
      console.warn("Polly playback failed.", error);
      await this.audioCache.deleteCachedAudio(cacheKey).catch(() => {});
      try {
        const blob = await this.loadAudioBlob(text, cacheKey, true);
        if (typeof options.shouldContinue === "function" && !options.shouldContinue()) {
          throw new Error("Playback cancelled.");
        }
        await this.playBlob(blob, options);
        return;
      } catch (retryError) {
        if (retryError?.message === "Playback cancelled.") throw retryError;
        console.warn("Fresh Polly playback failed.", retryError);
        if (this.fallbackEngine) {
          this.useFallbackOnly = true;
          setStatus("Using system voice for this sentence.");
          await this.fallbackEngine.speakSentence(text, { ...options, voice: null });
          return;
        }
        throw this.audioError(retryError);
      }
    }
  }

  async loadAudioBlob(text, cacheKey, refreshAudio) {
    this.beginAudioLoad();
    try {
      return await this.getAudioBlob(text, cacheKey, refreshAudio);
    } finally {
      this.endAudioLoad();
    }
  }

  async getAudioBlob(text, cacheKey, refreshAudio) {
    let blob = null;
    try {
      if (!refreshAudio) blob = await this.audioCache.getCachedAudio(cacheKey);
    } catch (error) {
      console.warn("Polly audio cache read failed.", error);
    }
    if (blob) return blob;

    const response = await fetch("/api/speak", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(refreshAudio ? { "X-Reader-Refresh-Audio": "1" } : {})
      },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Polly speech request failed.");
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("audio/")) {
      throw new Error("Polly returned an unsupported audio response.");
    }
    blob = await response.blob();
    if (!this.isPlayableAudioBlob(blob)) {
      throw new Error("Polly returned unsupported audio.");
    }
    try {
      await this.audioCache.putCachedAudio(cacheKey, blob);
    } catch (error) {
      console.warn("Polly audio cache write failed.", error);
    }
    return blob;
  }

  beginAudioLoad() {
    this.loadingAudioCount += 1;
  }

  endAudioLoad() {
    this.loadingAudioCount = Math.max(0, this.loadingAudioCount - 1);
  }

  playBlob(blob, options) {
    return new Promise((resolve, reject) => {
      const audio = this.currentAudio;
      let started = false;
      let settled = false;

      const cleanup = () => {
        audio.removeEventListener("canplay", start);
        audio.removeEventListener("loadedmetadata", start);
        audio.removeEventListener("ended", finish);
        audio.removeEventListener("error", failFromMediaElement);
        window.clearTimeout(startTimer);
        if (this.currentReject === fail) this.currentReject = null;
      };
      const finish = async () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.releaseAudioSource();
        try {
          await options.onEnd?.({ type: "ended", target: audio });
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.releaseAudioSource();
        options.onError?.(error);
        reject(this.audioError(error));
      };
      const failFromMediaElement = () => fail(audio.error || new Error("Audio playback failed."));
      const start = () => {
        if (started || settled) return;
        started = true;
        audio.play()
          .then(() => {
            clearTtsPending("audio start");
            options.onStart?.();
          })
          .catch(fail);
      };

      this.currentReject = fail;
      this.releaseAudioSource();
      this.currentObjectUrl = URL.createObjectURL(blob);
      audio.src = this.currentObjectUrl;
      audio.playbackRate = this.normalizeRate(options.rate);
      this.isPausedManually = false;
      audio.addEventListener("canplay", start);
      audio.addEventListener("loadedmetadata", start);
      audio.addEventListener("ended", finish);
      audio.addEventListener("error", failFromMediaElement);
      const startTimer = window.setTimeout(start, 1200);
      audio.load();
    });
  }

  async cacheKey(text, options) {
    const voice = options.voice?.voiceURI || "polly-joanna";
    const payload = `polly:v1:${voice}:standard:mp3:${text}`;
    if (!globalThis.crypto?.subtle) return `fallback-${this.hashString(payload)}`;
    const data = new TextEncoder().encode(payload);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  setRate(rate) {
    if (this.currentAudio) {
      this.currentAudio.playbackRate = this.normalizeRate(rate);
    }
  }

  normalizeRate(rate) {
    return clamp(Number(rate) || 1, 0.6, 2);
  }

  isPlayableAudioBlob(blob) {
    return blob?.size > 0 && (!blob.type || blob.type.includes("audio/") || blob.type === "application/octet-stream");
  }

  audioError(error) {
    if (error?.name === "NotSupportedError") {
      return new Error("This audio could not be played. The app retried Polly and fell back to the system voice.");
    }
    if (error?.name === "NotAllowedError") {
      return new Error("Browser audio playback was blocked. Press Read aloud again.");
    }
    return error instanceof Error ? error : new Error("Audio playback failed.");
  }

  releaseAudioSource() {
    this.currentAudio.pause();
    this.currentAudio.removeAttribute("src");
    this.currentAudio.load();
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = "";
    }
  }

  pause() {
    if (this.useFallbackOnly && this.fallbackEngine) {
      this.fallbackEngine.pause();
      return;
    }
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.isPausedManually = true;
    }
  }

  continuePlayback() {
    if (this.useFallbackOnly && this.fallbackEngine) {
      this.fallbackEngine.continuePlayback();
      return;
    }
    if (this.currentAudio && this.isPausedManually) {
      this.currentAudio.play()
        .then(() => {
          this.isPausedManually = false;
        })
        .catch((error) => setStatus(this.audioError(error).message));
    }
  }

  async cancel() {
    if (this.currentAudio) {
      if (this.currentReject) this.currentReject(new Error("Playback cancelled."));
      this.releaseAudioSource();
      this.isPausedManually = false;
    }
    this.loadingAudioCount = 0;
    if (this.fallbackEngine) await this.fallbackEngine.cancel();
  }

  getPlaybackState() {
    const fallbackState = this.fallbackEngine?.getPlaybackState?.() || { mode: "idle" };
    if (this.useFallbackOnly || fallbackState.mode !== "idle") return fallbackState;
    if (this.loadingAudioCount > 0) {
      return { mode: "speaking", speaking: false, paused: false, pending: true };
    }
    if (this.isPausedManually) {
      return { mode: "paused", speaking: false, paused: true, pending: false };
    }
    const audio = this.currentAudio;
    const hasSource = Boolean(audio?.currentSrc || audio?.src);
    if (hasSource && !audio.paused && !audio.ended) {
      return { mode: "speaking", speaking: true, paused: false, pending: false };
    }
    if (hasSource && this.currentReject) {
      return { mode: "speaking", speaking: false, paused: false, pending: true };
    }
    return { mode: "idle", speaking: false, paused: false, pending: false };
  }
}

const libraryStore = new LibraryStore();
const speechEngine = new PollyEngine(libraryStore, new WebSpeechEngine());

async function init() {
  await cancelQueuedSpeechOnInit();
  resetRuntimePlaybackFlags();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = CDN_PDF_WORKER;
  }

  bindEvents();
  configureMediaSession();
  await loadVoices();
  window.speechSynthesis?.addEventListener("voiceschanged", loadVoices);
  await refreshLibrary();
  await openLastActiveBook();
  updateControls();
  setBusy(false);
}

function ttsDebug(...args) {
  if (DEBUG_TTS) console.log("[tts]", ...args);
}

function getSpeechSynthesisState() {
  const synthesis = window.speechSynthesis;
  return {
    speaking: Boolean(synthesis?.speaking),
    paused: Boolean(synthesis?.paused),
    queuePending: Boolean(synthesis?.pending)
  };
}

function getTtsPlaybackState() {
  const speechStatus = getSpeechSynthesisState();
  const engineStatus = speechEngine?.getPlaybackState?.() || { mode: "idle", speaking: false, paused: false, pending: false };
  const mode = speechStatus.paused || engineStatus.paused || ttsControl.intent === "paused" || state.isPaused
    ? "paused"
    : speechStatus.speaking || speechStatus.queuePending || engineStatus.speaking || engineStatus.pending || (state.isPlaying && ttsControl.intent === "playing")
      ? "speaking"
      : "idle";
  return {
    mode,
    speaking: speechStatus.speaking || Boolean(engineStatus.speaking),
    paused: speechStatus.paused || Boolean(engineStatus.paused),
    pending: speechStatus.queuePending || Boolean(engineStatus.pending),
    speech: speechStatus,
    engine: engineStatus
  };
}

function logTtsState(event, extra = {}) {
  const status = getTtsPlaybackState();
  ttsDebug(event, {
    speaking: status.speaking,
    paused: status.paused,
    pending: ttsControl.pending,
    queuePending: status.speech.queuePending,
    audioPending: status.engine.pending,
    mode: status.mode,
    intent: ttsControl.intent,
    ...extra
  });
}

function resetRuntimePlaybackFlags() {
  state.playbackToken += 1;
  resetFreshPlaybackState();
  state.speechQueue = [];
  stopTtsWatchdog();
  currentUtteranceRef.current = null;
}

function resetFreshPlaybackState() {
  state.currentChunkIndex = 0;
  state.chapterIndex = 0;
  state.sentenceIndex = 0;
  state.isPlaying = false;
  state.isPaused = false;
  ttsControl.pending = false;
  window.clearTimeout(ttsControl.pendingTimer);
  ttsControl.pendingTimer = 0;
  ttsControl.intent = "idle";
  ttsControl.intentStopped = false;
}

function waitForNextTick() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function resetSpeech(reason = "reset") {
  const synthesis = window.speechSynthesis;
  if (!synthesis) return;

  synthesis.cancel();
  currentUtteranceRef.current = null;
  logTtsState("resetSpeech cancel", { reason });
  await waitForNextTick();

  const deadline = performance.now() + 250;
  while ((synthesis.speaking || synthesis.paused) && performance.now() < deadline) {
    if (synthesis.paused) synthesis.resume();
    synthesis.cancel();
    await waitForNextTick();
  }

  logTtsState("resetSpeech done", { reason });
  if (synthesis.speaking || synthesis.paused) {
    throw new Error("Speech synthesis queue did not reset.");
  }
}

function beginTtsTransition() {
  ttsControl.pending = true;
  window.clearTimeout(ttsControl.pendingTimer);
  ttsControl.pendingTimer = window.setTimeout(() => clearTtsPending("timeout"), 250);
  updateControls();
}

function clearTtsPending(reason) {
  if (!ttsControl.pending) return;
  ttsControl.pending = false;
  window.clearTimeout(ttsControl.pendingTimer);
  ttsControl.pendingTimer = 0;
  logTtsState("pending cleared", { reason });
  updateControls();
}

function startTtsWatchdog() {
  if (ttsControl.watchdogId) return;
  ttsControl.watchdogId = window.setInterval(() => {
    const synthesis = window.speechSynthesis;
    if (ttsControl.intent !== "playing") {
      stopTtsWatchdog();
      return;
    }
    if (synthesis?.paused) {
      logTtsState("watchdog continue");
      synthesis.resume();
    }
  }, 1000);
}

function stopTtsWatchdog() {
  if (!ttsControl.watchdogId) return;
  window.clearInterval(ttsControl.watchdogId);
  ttsControl.watchdogId = 0;
}

async function cancelQueuedSpeechOnInit() {
  await resetSpeech("init").catch((error) => {
    console.warn(error);
  });
  ttsDebug("speechSynthesis.cancel() called on init", Boolean(window.speechSynthesis));
}

function bindEvents() {
  elements.fileInput.addEventListener("change", handleUpload);
  elements.clearLibraryButton.addEventListener("click", clearLibrary);
  elements.chapterSelect.addEventListener("change", () => openChapter(Number(elements.chapterSelect.value), 0));
  elements.previousChapterButton.addEventListener("click", () => openChapter(state.chapterIndex - 1, 0));
  elements.nextChapterButton.addEventListener("click", () => openChapter(state.chapterIndex + 1, 0));
  elements.playButton.addEventListener("click", () => handleTtsButtonPress("play"));
  elements.pauseButton.addEventListener("click", () => handleTtsButtonPress("pause"));
  elements.previousSentenceButton.addEventListener("click", () => moveSentence(-1, true));
  elements.nextSentenceButton.addEventListener("click", () => moveSentence(1, true));
  elements.rateSlider.addEventListener("input", () => {
    const rate = Number(elements.rateSlider.value);
    elements.rateValue.textContent = `${rate.toFixed(1)}x`;
    speechEngine.setRate(rate);
  });
  elements.readerSurface.addEventListener("click", (event) => {
    const sentence = event.target.closest(".sentence");
    if (!sentence) return;
    setPosition(Number(sentence.dataset.chapterIndex), Number(sentence.dataset.sentenceIndex));
  });
}

function configureMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => handleTtsButtonPress("play"));
  navigator.mediaSession.setActionHandler("pause", () => handleTtsButtonPress("pause"));
  navigator.mediaSession.setActionHandler("stop", () => stopPlayback());
  navigator.mediaSession.setActionHandler("previoustrack", () => moveSentence(-1, true));
  navigator.mediaSession.setActionHandler("nexttrack", () => moveSentence(1, true));
}

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !state.activeBook) return;
  if ("MediaMetadata" in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.activeBook.title || state.activeBook.name || "Aurum Reader",
      artist: state.activeBook.author || "Aurum Reader",
      album: state.chapters[state.chapterIndex]?.title || "",
      artwork: [{ src: "./icon.svg", sizes: "128x128", type: "image/svg+xml" }]
    });
  }
  navigator.mediaSession.playbackState = state.isPlaying && !state.isPaused ? "playing" : state.isPaused ? "paused" : "none";
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

async function openLastActiveBook() {
  if (!state.books.length) return;
  const savedBookId = await libraryStore.getAppState(LAST_ACTIVE_BOOK_KEY);
  const book = state.books.find((item) => item.id === savedBookId) || state.books[0];
  if (book) await openBook(book.id, { source: "app-open" });
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
    lastOpenedAt: Date.now()
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

async function openBook(id, options = {}) {
  const book = state.books.find((item) => item.id === id) || (await libraryStore.getAllBooks()).find((item) => item.id === id);
  if (!book) return;

  await stopPlayback();
  resetRuntimePlaybackFlags();
  state.activeBookId = id;
  state.activeBook = sanitizeBookForStorage(book);
  setBusy(true, `Extracting ${book.kind.toUpperCase()} text...`);

  try {
    const extracted = book.kind === "epub" ? await extractEpubBook(book.fileBlob) : await extractPdfBook(book.fileBlob);
    state.chapters = extracted.chapters;
    state.speechQueue = buildSpeechQueue();
    state.activeBook.title = extracted.title || book.title || book.name;
    state.activeBook.author = extracted.author || book.author || "";
    state.activeBook.lastOpenedAt = Date.now();
    await cancelQueuedSpeechOnInit();
    resetFreshPlaybackState();
    const savedChunkIndex = loadSavedChunkIndex(state.activeBook);
    setCurrentChunkIndex(savedChunkIndex, false, { allowEnd: true });
    if (options.source === "app-open") {
      ttsDebug("app open", {
        bookId: id,
        savedChunkIndex,
        chunksLength: state.speechQueue.length
      });
    }
    await libraryStore.setAppState(LAST_ACTIVE_BOOK_KEY, id);
    state.books = state.books.map((item) => (item.id === id ? state.activeBook : item));
    renderLibrary();
    renderBook();
    highlightCurrentSentence(true);
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
  updateMediaSession();
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

async function handleTtsButtonPress(source) {
  const now = performance.now();
  logTtsState("button press", { source });
  if (ttsControl.pending) {
    logTtsState("button press ignored while pending", { source });
    return;
  }
  if (now - ttsControl.lastButtonPressAt < 150) {
    logTtsState("button press debounced", { source });
    return;
  }
  ttsControl.lastButtonPressAt = now;

  beginTtsTransition();
  const mode = getTtsPlaybackState().mode;
  try {
    if (mode === "paused") {
      await continuePausedPlayback();
      return;
    }
    if (mode === "speaking") {
      pausePlayback();
      return;
    }
    await handleIdleTtsPress(source);
  } catch (error) {
    ttsControl.intent = "idle";
    state.isPlaying = false;
    state.isPaused = false;
    stopTtsWatchdog();
    clearTtsPending("error");
    updateControls();
    setStatus(error.message || "Speech playback failed.");
  }
}

async function handleIdleTtsPress(source) {
  if (source === "pause" && !state.isPlaying) {
    clearTtsPending("idle pause");
    return;
  }
  if (source === "pause" && state.isPlaying && !state.isPaused) {
    pausePlayback();
    return;
  }
  if (state.isPaused) {
    await continuePausedPlayback();
    return;
  }
  if (state.isPlaying) return;

  if (source === "play") {
    ttsDebug("play tap", {
      currentChunkIndex: state.currentChunkIndex,
      chunksLength: state.speechQueue.length
    });
  }
  await startPlayback(state.currentChunkIndex, "play");
}

function pausePlayback() {
  const playback = getTtsPlaybackState();
  if (!state.isPlaying && playback.mode !== "speaking") {
    clearTtsPending("idle pause");
    return;
  }
  ttsControl.intent = "paused";
  ttsControl.intentStopped = true;
  stopTtsWatchdog();
  if (playback.speech.speaking || playback.speech.queuePending) window.speechSynthesis?.pause();
  if (playback.engine.speaking || playback.engine.paused) {
    speechEngine.pause();
  } else if (playback.engine.pending || (state.isPlaying && !state.isPaused)) {
    state.playbackToken += 1;
  }
  state.isPaused = true;
  state.isPlaying = true;
  clearTtsPending("pause");
  updateControls();
}

async function continuePausedPlayback() {
  const playback = getTtsPlaybackState();
  ttsControl.intent = "playing";
  ttsControl.intentStopped = false;
  startTtsWatchdog();
  if (playback.speech.paused || playback.engine.paused) {
    if (playback.speech.paused) window.speechSynthesis?.resume();
    speechEngine.continuePlayback();
  } else {
    await resetSpeech("continue paused pending");
    state.isPlaying = false;
    state.isPaused = false;
    await startPlayback(state.currentChunkIndex, "play");
    return;
  }
  state.isPaused = false;
  state.isPlaying = true;
  updateControls();
}

async function startPlayback(fromChunkIndex = 0, source = "play") {
  if (!state.chapters.length) return;

  const savedIndex = Number.isInteger(fromChunkIndex) ? fromChunkIndex : 0;
  ttsControl.intentStopped = false;
  state.speechQueue = buildSpeechQueue();
  ttsDebug("startPlayback entry", {
    source,
    savedIndex,
    chunksLength: state.speechQueue.length,
    intentStopped: ttsControl.intentStopped
  });
  if (!state.speechQueue.length) return;

  await resetSpeech("start playback");
  setCurrentChunkIndex(savedIndex, true, { allowEnd: true });
  if (state.currentChunkIndex >= state.speechQueue.length) {
    await finishPlaybackState();
    return;
  }

  const token = ++state.playbackToken;
  state.isPlaying = true;
  state.isPaused = false;
  ttsControl.intent = "playing";
  startTtsWatchdog();
  updateControls();

  const finishPlayback = async () => {
    if (state.playbackToken !== token) return;
    await finishPlaybackState();
  };

  const speakNext = async () => {
    const currentIndex = state.currentChunkIndex;
    const chunksLength = state.speechQueue.length;
    const willSpeak = state.playbackToken === token
      && !ttsControl.intentStopped
      && ttsControl.intent === "playing"
      && currentIndex < chunksLength;
    ttsDebug("speakNext entry", {
      currentIndex,
      chunksLength,
      intentStopped: ttsControl.intentStopped,
      willSpeak
    });

    if (!willSpeak) {
      if (state.playbackToken === token && !ttsControl.intentStopped) {
        await finishPlayback();
      }
      return;
    }

    const chunk = state.speechQueue[currentIndex];
    applyChunkPosition(chunk, true);
    highlightCurrentSentence(true);
    ttsDebug("speak chunk", {
      currentChunkIndex: state.currentChunkIndex,
      chapterIndex: chunk.chapterIndex,
      sentenceIndex: chunk.sentenceIndex,
      chunkLength: chunk.text.length
    });
    let errorLogged = false;
    const speechOptions = {
      voice: state.voices[Number(elements.voiceSelect.value)] || null,
      rate: Number(elements.rateSlider.value),
      shouldContinue: () => state.playbackToken === token && !ttsControl.intentStopped && ttsControl.intent === "playing",
      onStart: () => logTtsState("onstart", {
        currentChunkIndex: state.currentChunkIndex,
        chapterIndex: chunk.chapterIndex,
        sentenceIndex: chunk.sentenceIndex,
        chunkLength: chunk.text.length
      }),
      onEnd: async () => {
        const completedIndex = currentIndex;
        const nextIndex = clampChunkIndex(completedIndex + 1, { allowEnd: true });
        const chunksLength = state.speechQueue.length;
        const shouldPersist = state.playbackToken === token
          && !ttsControl.intentStopped
          && ttsControl.intent === "playing"
          && state.currentChunkIndex === completedIndex
          && completedIndex < chunksLength;
        let persistedIndex = state.currentChunkIndex;
        if (shouldPersist) {
          state.currentChunkIndex = nextIndex;
          persistedIndex = await persistCompletedChunkIndex(completedIndex, nextIndex);
        }
        ttsDebug("onend", {
          completedIndex,
          nextIndex,
          persistedIndex
        });
      },
      onError: (event) => {
        errorLogged = true;
        ttsDebug("onerror", {
          currentIndex: state.currentChunkIndex,
          chunksLength: state.speechQueue.length,
          intentStopped: ttsControl.intentStopped,
          event
        });
      }
    };
    const audioCacheKey = await getSpeechCacheKey(chunk.text, speechOptions);
    if (state.playbackToken !== token) return;
    try {
      await speechEngine.speakSentence(chunk.text, speechOptions);
      if (state.playbackToken !== token || ttsControl.intentStopped) return;
      await markChunkRead(chunk, audioCacheKey);
    } catch (error) {
      if (!errorLogged) {
        ttsDebug("onerror", {
          currentIndex: state.currentChunkIndex,
          chunksLength: state.speechQueue.length,
          intentStopped: ttsControl.intentStopped,
          event: error
        });
      }
      if (state.playbackToken === token) setStatus(String(error));
      await finishPlayback();
      return;
    }

    if (state.playbackToken !== token) return;
    if (state.currentChunkIndex >= state.speechQueue.length) {
      await finishPlayback();
      return;
    }

    await speakNext();
  };

  await speakNext();
}

async function finishPlaybackState() {
  state.isPlaying = false;
  state.isPaused = false;
  ttsControl.intent = "idle";
  stopTtsWatchdog();
  updateControls();
}

async function stopPlayback() {
  state.playbackToken += 1;
  state.isPlaying = false;
  state.isPaused = false;
  ttsControl.intent = "idle";
  ttsControl.intentStopped = true;
  currentUtteranceRef.current = null;
  stopTtsWatchdog();
  clearTtsPending("stop");
  await Promise.resolve(speechEngine.cancel()).catch((error) => {
    console.warn(error);
  });
  updateControls();
}

async function moveSentence(delta, restartPlayback) {
  if (!state.chapters.length) return;
  const wasPlaying = state.isPlaying && !state.isPaused;
  await stopPlayback();

  setCurrentChunkIndex(state.currentChunkIndex + delta, true);
  highlightCurrentSentence(true);
  if (restartPlayback && wasPlaying) {
    await startPlayback(state.currentChunkIndex, "play");
  }
}

async function openChapter(chapterIndex, sentenceIndex = 0) {
  if (!state.chapters.length) return;
  await stopPlayback();
  const nextChapterIndex = clamp(chapterIndex, 0, state.chapters.length - 1);
  const nextSentenceIndex = clamp(sentenceIndex, 0, Math.max(0, state.chapters[nextChapterIndex]?.sentences.length - 1));
  setCurrentChunkIndex(findChunkIndex(nextChapterIndex, nextSentenceIndex), false);
  updateControls();
}

async function setPosition(chapterIndex, sentenceIndex) {
  await stopPlayback();
  setCurrentChunkIndex(findChunkIndex(chapterIndex, sentenceIndex), true);
  highlightCurrentSentence(true);
}

function getCurrentSentences() {
  return state.chapters[state.chapterIndex]?.sentences || [];
}

function buildSpeechQueue() {
  const queue = [];
  state.chapters.forEach((chapter, chapterIndex) => {
    chapter.sentences.forEach((sentence, sentenceIndex) => {
      queue.push({
        chapterIndex,
        sentenceIndex,
        text: sentence
      });
    });
  });
  return queue;
}

function loadSavedChunkIndex(book) {
  const position = normalizeSavedPosition(book);
  if (!position || position.bookId !== book.id) return 0;
  return clampChunkIndex(position.savedChunkIndex, { allowEnd: true });
}

function findChunkIndex(chapterIndex, sentenceIndex) {
  const index = state.speechQueue.findIndex((chunk) => (
    chunk.chapterIndex === chapterIndex && chunk.sentenceIndex === sentenceIndex
  ));
  return index >= 0 ? index : 0;
}

function setCurrentChunkIndex(chunkIndex, scroll = true, options = {}) {
  if (!state.speechQueue.length) state.speechQueue = buildSpeechQueue();
  state.currentChunkIndex = clampChunkIndex(chunkIndex, options);
  const current = state.speechQueue[Math.min(state.currentChunkIndex, Math.max(0, state.speechQueue.length - 1))];
  if (current) applyChunkPosition(current, scroll);
}

function clampChunkIndex(chunkIndex, options = {}) {
  const maxIndex = options.allowEnd ? state.speechQueue.length : Math.max(0, state.speechQueue.length - 1);
  return clamp(Number.isInteger(chunkIndex) ? chunkIndex : 0, 0, maxIndex);
}

function applyChunkPosition(chunk, scroll = true) {
  const previousChapterIndex = state.chapterIndex;
  state.chapterIndex = chunk.chapterIndex;
  state.sentenceIndex = chunk.sentenceIndex;
  if (previousChapterIndex !== state.chapterIndex || elements.chapterSelect.value !== String(state.chapterIndex)) {
    renderChapter();
  }
  if (scroll) highlightCurrentSentence(true);
}

async function markChunkRead(chunk, audioCacheKey) {
  await libraryStore.markSentenceRead(
    state.activeBookId,
    chunk.chapterIndex,
    chunk.sentenceIndex,
    chunk.text,
    audioCacheKey
  );
}

async function getSpeechCacheKey(sentence, options) {
  if (typeof speechEngine.cacheKey !== "function") return "";
  return speechEngine.cacheKey(sentence, options).catch(() => "");
}

async function persistCompletedChunkIndex(completedIndex, nextIndex) {
  if (!state.activeBook) return nextIndex;
  const persistedIndex = clampChunkIndex(nextIndex, { allowEnd: true });
  const bookToSave = sanitizeBookForStorage({
    ...state.activeBook,
    position: {
      bookId: state.activeBook.id,
      savedChunkIndex: persistedIndex
    },
    lastOpenedAt: Date.now()
  });
  state.activeBook = bookToSave;
  await libraryStore.setAppState(LAST_ACTIVE_BOOK_KEY, state.activeBook.id);
  await libraryStore.putBook(bookToSave);
  state.books = state.books.map((book) => (book.id === state.activeBook.id ? state.activeBook : book));
  return persistedIndex;
}

function sanitizeBookForStorage(book) {
  if (!book) return book;
  const sanitized = { ...book };
  PLAYBACK_RUNTIME_STORAGE_KEYS.forEach((key) => {
    delete sanitized[key];
  });

  const position = normalizeSavedPosition(book);
  if (position) {
    sanitized.position = position;
  } else {
    delete sanitized.position;
  }
  return sanitized;
}

function normalizeSavedPosition(book) {
  const position = book?.position;
  if (
    position?.bookId === book?.id
    && Number.isInteger(position.savedChunkIndex)
  ) {
    return {
      bookId: position.bookId,
      savedChunkIndex: position.savedChunkIndex
    };
  }
  return null;
}

async function clearLibrary() {
  await stopPlayback();
  await libraryStore.clearBooks();
  await libraryStore.clearAppState();
  state.books = [];
  state.activeBook = null;
  state.activeBookId = null;
  state.chapters = [];
  state.speechQueue = [];
  state.currentChunkIndex = 0;
  state.chapterIndex = 0;
  state.sentenceIndex = 0;
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
  elements.playButton.disabled = !hasBook || ttsControl.pending;
  elements.pauseButton.disabled = !hasBook || !state.isPlaying || ttsControl.pending;
  elements.playButton.textContent = state.isPaused ? "Continue reading" : "Read aloud";
  elements.pauseButton.textContent = state.isPaused ? "Continue" : "Hold";
  updateMediaSession();
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
