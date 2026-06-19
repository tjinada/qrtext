const BUILD_ID = "debug12-2026-06-18";
const $ = (id) => document.getElementById(id);

const state = {
  // AQR3 section generators. Each section is an independent LT stream; the user
  // displays one section at a time and the phone banks each as it completes.
  sections: [],             // [{ sec, secs, K, secBytes, secHash, blocks, generator }]
  activeSection: 0,
  frameSeq: 0,              // frames emitted in the active section (display only)
  lastBuiltFrame: "",       // most recently rendered AQR3 frame string
  intervalId: null,
  scanner: null,
  videoStream: null,
  scanTimer: null,
  detector: null,
  sectionDecoders: {},      // sec -> LTDecoder (in-progress sections, web test decoder)
  sectionBytes: {},         // sec -> Uint8Array (completed + verified section bytes)
  activeTransfer: null,
  rebuiltBlob: null,
  rebuiltText: "",
  displayMode: false,
  lastDecoded: "",
  scanStarting: false,
  // Scanner telemetry
  scanAttempts: 0,
  scanSuccesses: 0,
  scanFailures: 0,
  scanHeartbeat: null,
  lastDecodeAt: 0,
  videoTrack: null,
  videoSettings: null
};

const QR_OPTIONS = {
  // ECC M (15%) is plenty for screen->camera transfer. ECC H was designed for
  // damaged printed surfaces and just makes the QR denser for no real benefit.
  errorCorrectionLevel: "M",
  // CSS border on .qr-wrap canvas already provides visual quiet zone, so we
  // only need the minimum 2-module quiet zone the QR spec requires.
  margin: 2,
  scale: 10,
  color: {
    dark: "#000000",
    light: "#ffffff"
  }
};

const DEBUG = true;

function safeStringify(value) {
  try {
    if (value instanceof Error) {
      return JSON.stringify({
        name: value.name,
        message: value.message,
        stack: value.stack
      }, null, 2);
    }
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatError(error) {
  if (!error) return "Unknown error. The browser returned an empty error object.";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  if (error.name) return `${error.name}${error.constraint ? `: ${error.constraint}` : ""}`;
  return safeStringify(error);
}

function debugLog(message, data) {
  if (!DEBUG) return;

  const line = data === undefined
    ? `[${new Date().toLocaleTimeString()}] ${message}`
    : `[${new Date().toLocaleTimeString()}] ${message} ${safeStringify(data)}`;

  console.log(line);

  const el = $("debugLog");
  if (el) {
    el.textContent += `${line}\n`;
    el.scrollTop = el.scrollHeight;
  }
}

window.addEventListener("error", (event) => {
  debugLog("window.error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: formatError(event.error)
  });
});

window.addEventListener("unhandledrejection", (event) => {
  debugLog("unhandledrejection", formatError(event.reason));
  setScannerStatus(`Unhandled promise rejection: ${formatError(event.reason)}`, "error");
});

function base64UrlEncode(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str || ""));
}

function decodeString(str) {
  return new TextDecoder().decode(base64UrlDecode(str || ""));
}

async function sha256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// =============================================================================
// LT / fountain codes (AQR2)
// -----------------------------------------------------------------------------
// The encoder splits the payload into K fixed-size source blocks, then emits an
// infinite stream of frames. Each frame is one XOR of a random subset of source
// blocks. The seed in the frame deterministically encodes WHICH blocks were
// XOR'd. Both the JS encoder and the Swift decoder must agree on:
//
//   (a) the PRNG (mulberry32 — bit-identical 32-bit integer math)
//   (b) the soliton degree distribution
//   (c) the rejection-sampling rule for picking unique indices
//
// Cross-platform determinism is the only place this can go subtly wrong, so
// the math below is intentionally simple and translates to Swift line-for-line.
// =============================================================================

// mulberry32: small, fast, seedable. Identical output to the Swift port.
// Returns a function that emits uint32 values; helpers below convert to float
// or to bounded integers.
function mulberry32(seed) {
  // Force seed into uint32 range.
  let s = seed >>> 0;
  return function next() {
    // Increment in uint32 arithmetic. Math.imul wraps to 32-bit signed but the
    // >>> 0 below normalizes back to unsigned.
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

function nextFloat(rng) {
  // Map uint32 -> [0, 1). Matches the Swift port: Double(uint32) / 2^32.
  return rng() / 4294967296;
}

function nextIntBelow(rng, bound) {
  // Returns an integer in [0, bound). For our small bounds (K <= 256) the
  // mod bias is negligible, but the same rule applies in Swift so behavior
  // is identical.
  return rng() % bound;
}

// Robust soliton distribution.
// In practice we use a slightly tweaked Ideal Soliton because for small K it
// converges faster and is simpler to keep identical across languages.
// Returns an integer degree in [1, K].
function sampleDegree(rng, K) {
  // Ideal soliton: P(1) = 1/K, P(i) = 1 / (i * (i-1)) for i = 2..K.
  // Sample by drawing u in [0,1) and finding the smallest i with CDF(i) >= u.
  const u = nextFloat(rng);
  let cum = 1 / K;
  if (u < cum) return 1;
  for (let i = 2; i <= K; i++) {
    cum += 1 / (i * (i - 1));
    if (u < cum) return i;
  }
  return K;
}

// Pick `degree` distinct indices from [0, K) using rejection sampling on a Set.
// Order doesn't matter for XOR, so we just collect a sorted array for stable
// hashing on both sides.
function pickIndices(rng, K, degree) {
  const set = new Set();
  while (set.size < degree) {
    set.add(nextIntBelow(rng, K));
  }
  return Array.from(set).sort((a, b) => a - b);
}

// XOR a list of equal-length Uint8Array blocks. Returns a new Uint8Array.
function xorBlocks(blocks, indices) {
  const blockSize = blocks[0].length;
  const out = new Uint8Array(blockSize);
  for (const i of indices) {
    const b = blocks[i];
    for (let k = 0; k < blockSize; k++) out[k] ^= b[k];
  }
  return out;
}

// Split the raw payload bytes into K fixed-size blocks, zero-padding the last.
// The decoder strips trailing padding using `totalBytes` carried in every frame.
function splitIntoKBlocks(payload, K) {
  const blockSize = Math.ceil(payload.length / K);
  const blocks = new Array(K);
  for (let i = 0; i < K; i++) {
    const start = i * blockSize;
    const slice = payload.subarray(start, Math.min(start + blockSize, payload.length));
    if (slice.length === blockSize) {
      blocks[i] = slice;
    } else {
      // Pad final short block with zeros so XOR is well-defined.
      const padded = new Uint8Array(blockSize);
      padded.set(slice, 0);
      blocks[i] = padded;
    }
  }
  return { blocks, blockSize };
}

// Build an AQR3 frame generator for ONE section. Each section is an independent
// LT stream; seeds 1,2,3,... feed mulberry32. `sec`/`secs` route the frame to
// the right section on the receiver; `secHash` lets the receiver verify the
// section the moment its LT decode completes.
function makeAQR3Generator({ id, sec, secs, alg, K, fileHash, secBytes, secHash, name, mime, blocks }) {
  let seed = 0;
  return {
    sec,
    secs,
    K,
    transferId: id,
    blockSize: blocks[0].length,
    totalBytes: secBytes,    // alias used by the LT sanity check + decoder
    secBytes,
    secHash,
    nextFrame() {
      seed = (seed + 1) >>> 0;
      const rng = mulberry32(seed);
      const degree = sampleDegree(rng, K);
      const indices = pickIndices(rng, K, degree);
      const xor = xorBlocks(blocks, indices);
      const xorB64 = base64UrlEncode(xor);
      // AQR3|id|sec|secs|seed|K|secBytes|secHash|alg|fileHash|nameB64|mimeB64|xorPayloadB64
      return [
        "AQR3",
        id,
        sec,
        secs,
        seed,
        K,
        secBytes,
        secHash,
        alg,
        fileHash,
        encodeString(name),
        encodeString(mime),
        xorB64
      ].join("|");
    }
  };
}

// Split the processed (gzipped) payload into `secs` contiguous slices. Each
// slice becomes its own independent LT stream / section. Returns the actual
// slices (may be fewer than requested if the file is tiny).
function sliceIntoSections(processedBytes, secs) {
  const out = [];
  const secLen = Math.ceil(processedBytes.length / secs);
  for (let s = 0; s < secs; s++) {
    const start = s * secLen;
    if (start >= processedBytes.length) break;
    const end = Math.min(start + secLen, processedBytes.length);
    out.push(processedBytes.subarray(start, end));
  }
  return out;
}

// =============================================================================
// LT decoder (web-side, used only for on-page round-trip testing)
// -----------------------------------------------------------------------------
// This mirrors the Swift LTDecoder line by line so the JS and Swift sides stay
// honest. If you change one, change both.
// =============================================================================

class LTDecoder {
  constructor({ K, blockSize, totalBytes }) {
    this.K = K;
    this.blockSize = blockSize;
    this.totalBytes = totalBytes;
    this.blocks = new Array(K).fill(null);   // recovered source blocks (Uint8Array)
    this.pending = [];                         // [{payload: Uint8Array, indices: Set<number>}]
    this.resolvedCount = 0;
    this.equationsSeen = 0;
  }

  isComplete() {
    return this.resolvedCount === this.K;
  }

  // Add a (seed, xorPayload) pair. Returns true if the equation contributed
  // (resolved at least one new block).
  addEquation(seed, xorPayload) {
    this.equationsSeen++;
    const rng = mulberry32(seed);
    const degree = sampleDegree(rng, this.K);
    const indices = new Set(pickIndices(rng, this.K, degree));

    // Reduce by all known blocks already.
    let payload = new Uint8Array(xorPayload);
    for (const i of Array.from(indices)) {
      if (this.blocks[i] !== null) {
        const known = this.blocks[i];
        for (let k = 0; k < payload.length; k++) payload[k] ^= known[k];
        indices.delete(i);
      }
    }

    if (indices.size === 0) return false;       // redundant equation
    if (indices.size === 1) {
      const idx = indices.values().next().value;
      this._resolve(idx, payload);
      this._propagate();
      return true;
    }
    this.pending.push({ payload, indices });
    return false;
  }

  _resolve(idx, payload) {
    if (this.blocks[idx] !== null) return;
    this.blocks[idx] = payload;
    this.resolvedCount++;
  }

  _propagate() {
    // Repeatedly walk pending equations, substituting any newly-known block.
    // Anything that collapses to a single unknown is resolved; this can cascade.
    let changed = true;
    while (changed) {
      changed = false;
      const stillPending = [];
      for (const eq of this.pending) {
        const indices = new Set(eq.indices);
        let payload = eq.payload;
        for (const i of Array.from(indices)) {
          if (this.blocks[i] !== null) {
            const known = this.blocks[i];
            // Cheap clone-on-write so we don't mutate the original payload.
            payload = new Uint8Array(payload);
            for (let k = 0; k < payload.length; k++) payload[k] ^= known[k];
            indices.delete(i);
          }
        }
        if (indices.size === 0) continue;          // dropped
        if (indices.size === 1) {
          const idx = indices.values().next().value;
          this._resolve(idx, payload);
          changed = true;
          continue;
        }
        stillPending.push({ payload, indices });
      }
      this.pending = stillPending;
    }
  }

  // Concatenate resolved blocks and trim to totalBytes.
  rebuild() {
    if (!this.isComplete()) return null;
    const out = new Uint8Array(this.K * this.blockSize);
    for (let i = 0; i < this.K; i++) {
      out.set(this.blocks[i], i * this.blockSize);
    }
    return out.subarray(0, this.totalBytes);
  }
}


function splitString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks;
}

function randomId() {
  return crypto.getRandomValues(new Uint8Array(6)).reduce((acc, b) => acc + b.toString(36).padStart(2, "0"), "").slice(0, 10);
}

function errorToMessage(err) {
  return formatError(err);
}

function setScannerStatus(message, kind = "muted") {
  const el = $("scannerStatus");
  if (!el) return;
  el.textContent = message;
  el.className = `scanner-status ${kind}`;
  debugLog("scannerStatus", { message, kind });
}

function wantsDisplayMode() {
  const params = new URLSearchParams(location.search);
  return params.get("mode") === "display" || location.pathname.endsWith("/display");
}

function buildDisplayUrl() {
  const url = new URL(location.href);
  // Works for http(s) and file://. For Docker, nginx also supports /display, but
  // query mode is safer for double-clicked offline index.html.
  url.pathname = url.pathname.endsWith("/display") ? url.pathname.replace(/\/display$/, "/") : url.pathname;
  url.hash = "";
  url.searchParams.set("mode", "display");
  return url.href;
}

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === tabName));
}

async function readInput() {
  const file = $("fileInput").files[0];
  if (file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      bytes,
      name: file.name || "transfer.bin",
      mime: file.type || "application/octet-stream"
    };
  }

  const text = $("textInput").value;
  if (!text.trim()) throw new Error("Paste text or choose a file first.");
  const name = $("fileName").value.trim() || "transfer.txt";
  return {
    bytes: new TextEncoder().encode(text),
    name,
    mime: "text/plain;charset=utf-8"
  };
}

function parseFrame(decodedText) {
  // Only AQR3 is accepted. Anything else (random QR, old AQR1/AQR2, JSON,
  // gibberish) returns null and the caller drops it.
  if (!decodedText.startsWith("AQR3|")) return null;
  const parts = decodedText.split("|");
  if (parts.length !== 13) return null;
  // AQR3|id|sec|secs|seed|K|secBytes|secHash|alg|fileHash|nameB64|mimeB64|xorB64
  const [, id, secStr, secsStr, seedStr, KStr, secBytesStr, secHash, alg, fileHash, nameB64, mimeB64, xorB64] = parts;
  const sec = Number(secStr);
  const secs = Number(secsStr);
  const seed = Number(seedStr);
  const K = Number(KStr);
  const secBytes = Number(secBytesStr);
  if (![sec, secs, seed, K, secBytes].every(Number.isFinite)) return null;
  if (secs <= 0 || sec < 0 || sec >= secs || seed <= 0 || K <= 0 || secBytes <= 0) return null;
  return {
    qrt: "aqr-transfer",
    v: 4,
    id,
    sec,
    secs,
    seed,
    K,
    secBytes,
    secHash,
    alg,
    fileHash,
    name: decodeString(nameB64),
    mime: decodeString(mimeB64),
    xorB64
  };
}

async function generateFrames() {
  stopAnimation();
  const { bytes, name, mime } = await readInput();
  const useCompression = $("useCompression").checked;
  const processedBytes = useCompression ? pako.gzip(bytes) : bytes;
  const alg = useCompression ? "gzip" : "raw";
  const id = randomId();
  const fileHash = await sha256Hex(bytes);
  const targetBlock = Number($("blockTarget").value) || 1400;

  const MAX_FRAME_CHARS = 2280;   // ECC M v40 byte-mode capacity, with headroom
  const K_MAX = 4000;

  // Decide how many sections to split the (gzipped) payload into. Each section
  // is an independent LT stream you scan and bank separately, so you don't have
  // to hold the phone for one long session.
  const secsChoice = $("sections").value;
  let secs;
  if (secsChoice === "auto") {
    const SECTION_TARGET = 262144;   // ~256 KB gzipped per section
    secs = Math.min(16, Math.max(1, Math.ceil(processedBytes.length / SECTION_TARGET)));
  } else {
    secs = Math.max(1, Number(secsChoice) || 1);
  }

  const slices = sliceIntoSections(processedBytes, secs);
  secs = slices.length;   // actual (tiny files may yield fewer)

  const sections = [];
  for (let s = 0; s < secs; s++) {
    const slice = slices[s];
    const secHash = (await sha256Hex(slice)).slice(0, 16);

    // Per-section auto-K so every section's frames fit a QR.
    let K = Math.max(2, Math.ceil(slice.length / targetBlock));
    if (K > K_MAX) {
      throw new Error(`Section ${s + 1} needs ${K.toLocaleString()} blocks (> ${K_MAX}). Use more sections or enable gzip.`);
    }
    let blocks, blockSize, fits = false;
    for (let attempt = 0; attempt < 24 && K <= K_MAX; attempt++) {
      const split = splitIntoKBlocks(slice, K);
      blocks = split.blocks;
      blockSize = split.blockSize;
      const probe = makeAQR3Generator({ id, sec: s, secs, alg, K, fileHash, secBytes: slice.length, secHash, name, mime, blocks });
      if (probe.nextFrame().length <= MAX_FRAME_CHARS) { fits = true; break; }
      K = Math.ceil(K * 1.3) + 1;
    }
    if (!fits) throw new Error(`Couldn't fit section ${s + 1} into scannable QR frames.`);

    const generator = makeAQR3Generator({ id, sec: s, secs, alg, K, fileHash, secBytes: slice.length, secHash, name, mime, blocks });
    // In-page LT round-trip sanity check for this section (catches PRNG/encoding
    // drift before the phone ever sees it).
    await sanityCheckLTRoundTrip(generator, slice, K);

    sections.push({ sec: s, secs, K, secBytes: slice.length, secHash, blocks, generator });
  }

  state.sections = sections;
  state.activeSection = 0;
  state.frameSeq = 0;
  state.lastBuiltFrame = sections[0].generator.nextFrame();
  state.frameSeq = 1;

  const totalK = sections.reduce((a, x) => a + x.K, 0);
  $("encodeStats").innerHTML = `
    Original: <strong>${bytes.length.toLocaleString()}</strong> bytes<br>
    Processed (post-gzip): <strong>${processedBytes.length.toLocaleString()}</strong> bytes<br>
    Sections: <strong>${secs}</strong> &nbsp;·&nbsp; total blocks <strong>${totalK.toLocaleString()}</strong><br>
    Section 1: <strong>K ${sections[0].K}</strong>, ${sections[0].secBytes.toLocaleString()} B<br>
    Algorithm: <strong>${alg}</strong> &nbsp;·&nbsp; ECC M, AQR3 / LT<br>
    <em>Scan one section at a time. Each finishes after ~1.5–2× its K unique frames; the phone banks each and recombines at the end.</em>
  `;
  $("transferId").textContent = `Transfer ID: ${id}`;

  updateSectionLabel();
  await renderCurrentFrame();
  startAnimation();
}

// --- Section navigation (encoder) ---

function activeGenerator() {
  const sec = state.sections[state.activeSection];
  return sec ? sec.generator : null;
}

function updateSectionLabel() {
  const el = $("sectionLabel");
  const secs = state.sections.length;
  if (el) {
    if (!secs) el.textContent = "No sections";
    else if (secs === 1) el.textContent = "Single section";
    else el.textContent = `Section ${state.activeSection + 1} / ${secs} — scan to completion, then advance`;
  }
  const prev = $("prevSectionBtn");
  const next = $("nextSectionBtn");
  const multi = secs > 1;
  if (prev) prev.disabled = !multi || state.activeSection <= 0;
  if (next) next.disabled = !multi || state.activeSection >= secs - 1;
}

async function gotoSection(idx) {
  if (!state.sections.length) return;
  state.activeSection = Math.max(0, Math.min(idx, state.sections.length - 1));
  state.frameSeq = 0;
  state.lastBuiltFrame = activeGenerator().nextFrame();
  state.frameSeq = 1;
  await renderCurrentFrame();
  updateSectionLabel();
  startAnimation();
}

function nextSection() { gotoSection(state.activeSection + 1); }
function prevSection() { gotoSection(state.activeSection - 1); }

// In-process round-trip test: feed the generator's output back into LTDecoder
// and verify the resulting bytes match. Cheap insurance that the JS
// PRNG/distribution/XOR code is internally consistent. Throws on mismatch so
// the user immediately sees a clear error instead of a silent decode failure
// on the phone.
async function sanityCheckLTRoundTrip(generator, expectedBytes, K) {
  const decoder = new LTDecoder({
    K,
    blockSize: generator.blockSize,
    totalBytes: generator.totalBytes
  });
  // We need our own generator instance so we don't consume seeds from the real one.
  const probeBlocks = splitIntoKBlocks(expectedBytes, K).blocks;
  let probeSeed = 0;
  const maxAttempts = K * 5;
  for (let i = 0; i < maxAttempts && !decoder.isComplete(); i++) {
    probeSeed++;
    const rng = mulberry32(probeSeed);
    const degree = sampleDegree(rng, K);
    const indices = pickIndices(rng, K, degree);
    const xor = xorBlocks(probeBlocks, indices);
    decoder.addEquation(probeSeed, xor);
  }
  if (!decoder.isComplete()) {
    throw new Error(`LT sanity check failed: decoder did not converge within ${maxAttempts} frames (K=${K}). PRNG/distribution drift?`);
  }
  const rebuilt = decoder.rebuild();
  if (rebuilt.length !== expectedBytes.length) {
    throw new Error(`LT sanity check failed: rebuilt length ${rebuilt.length} != expected ${expectedBytes.length}.`);
  }
  for (let i = 0; i < rebuilt.length; i++) {
    if (rebuilt[i] !== expectedBytes[i]) {
      throw new Error(`LT sanity check failed: byte mismatch at offset ${i}.`);
    }
  }
  debugLog("LT sanity check passed", { K, framesNeeded: decoder.equationsSeen, totalBytes: expectedBytes.length });
}

async function renderCurrentFrame() {
  const wrap = $("qrCanvasWrap");
  wrap.innerHTML = "";
  if (!state.sections.length || !state.lastBuiltFrame) {
    wrap.textContent = "QR frames will appear here";
    wrap.classList.add("empty");
    return;
  }

  wrap.classList.remove("empty");
  const canvas = document.createElement("canvas");
  canvas.className = "qr-canvas";
  wrap.appendChild(canvas);
  await QRCode.toCanvas(canvas, state.lastBuiltFrame, QR_OPTIONS);
  const secs = state.sections.length;
  const secLabel = secs > 1 ? ` · Section ${state.activeSection + 1}/${secs}` : "";
  $("frameCounter").textContent = `Frame seq ${state.frameSeq}${secLabel}`;
}

function advanceFrame() {
  // Honor the "Repeat each frame" dropdown by only emitting a new LT frame
  // every `hold` ticks. Repeating gives the camera multiple decode windows on
  // the same QR, which is what makes scanning consistently fast.
  const hold = Number($("frameHold").value || 1);
  const gen = activeGenerator();
  if (!gen) return;
  if (state.frameSeq % hold === 0 || !state.lastBuiltFrame) {
    state.lastBuiltFrame = gen.nextFrame();
  }
  state.frameSeq++;
  renderCurrentFrame();
}

function startAnimation() {
  if (!state.sections.length) return;
  stopAnimation();
  const fps = Number($("fps").value);
  state.intervalId = setInterval(advanceFrame, 1000 / fps);
  $("stopBtn").disabled = false;
  $("pausePlayBtn").textContent = "Pause";
}

function stopAnimation() {
  if (state.intervalId) clearInterval(state.intervalId);
  state.intervalId = null;
  $("stopBtn").disabled = true;
  if ($("pausePlayBtn")) $("pausePlayBtn").textContent = "Play";
}

function togglePausePlay() {
  if (!state.sections.length) return;
  if (state.intervalId) stopAnimation();
  else startAnimation();
}

// Previous/Next in LT mode aren't "go back to frame N" — there's no frame N to
// go back to. Instead, both buttons just emit a fresh LT frame from the active
// section so the user can step through manually.
async function previousFrame() {
  const gen = activeGenerator();
  if (!gen) return;
  stopAnimation();
  state.lastBuiltFrame = gen.nextFrame();
  state.frameSeq++;
  await renderCurrentFrame();
}

async function nextFrame() {
  const gen = activeGenerator();
  if (!gen) return;
  stopAnimation();
  state.lastBuiltFrame = gen.nextFrame();
  state.frameSeq++;
  await renderCurrentFrame();
}

function toggleDisplayMode(force) {
  state.displayMode = typeof force === "boolean" ? force : !state.displayMode;
  document.body.classList.toggle("display-mode", state.displayMode);

  if (state.displayMode) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    // Do not use #display anymore. A leftover hash caused the app to keep
    // booting into display mode after refresh.
    const url = new URL(location.href);
    url.hash = "";
    url.searchParams.set("mode", "display");
    history.replaceState(null, "", url.href);
  } else {
    document.exitFullscreen?.().catch(() => {});
    const url = new URL(location.href);
    url.hash = "";
    url.searchParams.delete("mode");
    if (url.pathname.endsWith("/display")) url.pathname = url.pathname.replace(/\/display$/, "/");
    history.replaceState(null, "", url.href);
  }
}

function openDisplayMode() {
  // Same window is best for file:// use and keeps generated QR frames in memory.
  toggleDisplayMode(true);
}


function resetDecode() {
  state.sectionDecoders = {};
  state.sectionBytes = {};
  state.activeTransfer = null;
  state.rebuiltBlob = null;
  state.rebuiltText = "";
  state.lastDecoded = "";
  $("decodeStats").textContent = "Waiting for QR frames.";
  $("missingChunks").textContent = "";
  $("meterBar").style.width = "0%";
  $("outputText").value = "";
  $("downloadBtn").disabled = true;
  $("copyBtn").disabled = true;
}

async function handleQrDecoded(decodedText) {
  if (!decodedText || decodedText === state.lastDecoded) return;
  state.lastDecoded = decodedText;

  const payload = parseFrame(decodedText);
  if (!payload || payload.qrt !== "aqr-transfer") return;

  // New transfer? Reset and adopt whole-file metadata.
  if (!state.activeTransfer || state.activeTransfer.id !== payload.id) {
    resetDecode();
    state.lastDecoded = decodedText;
    state.activeTransfer = {
      id: payload.id,
      secs: payload.secs,
      name: payload.name,
      mime: payload.mime,
      alg: payload.alg,
      fileHash: payload.fileHash,
      secsDone: new Set()
    };
  }

  if (payload.id !== state.activeTransfer.id) return;

  const sec = payload.sec;
  if (state.sectionBytes[sec]) { updateDecodeProgress(); return; }   // already banked

  // One LT decoder per section; created on first sight of that section.
  let dec = state.sectionDecoders[sec];
  if (!dec) {
    const firstXor = base64UrlDecode(payload.xorB64);
    dec = new LTDecoder({ K: payload.K, blockSize: firstXor.length, totalBytes: payload.secBytes });
    dec.secHash = payload.secHash;
    state.sectionDecoders[sec] = dec;
  }

  const xor = base64UrlDecode(payload.xorB64);
  if (xor.length !== dec.blockSize) return;
  dec.addEquation(payload.seed, xor);

  if (dec.isComplete()) {
    const secBytesArr = dec.rebuild();
    const gotHash = (await sha256Hex(secBytesArr)).slice(0, 16);
    if (gotHash === dec.secHash) {
      state.sectionBytes[sec] = secBytesArr;          // bank the verified section
      state.activeTransfer.secsDone.add(sec);
    }
    delete state.sectionDecoders[sec];                 // free it either way; rescan to retry
  }

  updateDecodeProgress();

  if (state.activeTransfer.secsDone.size === state.activeTransfer.secs) {
    await rebuildTransfer();
  }
}

function updateDecodeProgress() {
  const meta = state.activeTransfer;
  if (!meta) return;
  const done = meta.secsDone.size;
  $("meterBar").style.width = `${Math.round((done / meta.secs) * 100)}%`;

  // Per-section line: ✓ banked, % in-progress, — untouched.
  const cells = [];
  for (let s = 0; s < meta.secs; s++) {
    if (state.sectionBytes[s]) {
      cells.push(`S${s + 1} ✓`);
    } else if (state.sectionDecoders[s]) {
      const d = state.sectionDecoders[s];
      cells.push(`S${s + 1} ${Math.round((d.resolvedCount / d.K) * 100)}%`);
    } else {
      cells.push(`S${s + 1} —`);
    }
  }

  $("decodeStats").innerHTML = `
    Transfer ID: <strong>${meta.id}</strong><br>
    File: <strong>${meta.name}</strong><br>
    Sections banked: <strong>${done} / ${meta.secs}</strong><br>
    Algorithm: <strong>${meta.alg}</strong>
  `;
  $("missingChunks").textContent = cells.join("   ");
}

async function rebuildTransfer() {
  const meta = state.activeTransfer;
  if (!meta || meta.secsDone.size !== meta.secs) return;

  // Concatenate section payloads in order to reproduce the processed bytes.
  let totalLen = 0;
  for (let s = 0; s < meta.secs; s++) totalLen += state.sectionBytes[s].length;
  const processed = new Uint8Array(totalLen);
  let off = 0;
  for (let s = 0; s < meta.secs; s++) {
    processed.set(state.sectionBytes[s], off);
    off += state.sectionBytes[s].length;
  }

  let bytes = processed;
  if (meta.alg === "gzip") {
    try {
      bytes = pako.ungzip(processed);
    } catch (err) {
      $("missingChunks").textContent = `Gunzip failed: ${formatError(err)}`;
      return;
    }
  }

  const finalHash = await sha256Hex(bytes);
  if (finalHash !== meta.fileHash) {
    $("missingChunks").textContent = "Whole-file checksum failed. Reset and try again.";
    return;
  }

  state.rebuiltBlob = new Blob([bytes], { type: meta.mime || "application/octet-stream" });
  const isText = (meta.mime || "").startsWith("text/") || /\.(ts|tsx|js|jsx|json|xml|html|css|txt|md|log|yaml|yml)$/i.test(meta.name);

  if (isText) {
    state.rebuiltText = new TextDecoder().decode(bytes);
    $("outputText").value = state.rebuiltText;
    $("copyBtn").disabled = false;
  } else {
    $("outputText").value = "Binary file rebuilt. Use Download Rebuilt File.";
  }

  $("downloadBtn").disabled = false;
  $("decodeStats").innerHTML += `<br><span class="ok">All ${meta.secs} section(s) received. Checksum passed.</span>`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createAndStartHtml5Scanner(cameraConfig, scannerConfig) {
  const reader = $("reader");
  reader.innerHTML = "";

  const scanner = new Html5Qrcode("reader", { verbose: true });
  state.scanner = scanner;

  await scanner.start(
    cameraConfig,
    scannerConfig,
    (decodedText) => {
      state.scanSuccesses++;
      state.lastDecodeAt = Date.now();
      debugLog("QR decoded", decodedText ? decodedText.slice(0, 160) : decodedText);
      Promise.resolve(handleQrDecoded(decodedText)).catch((decodeErr) => {
        debugLog("handleQrDecoded failed", decodeErr);
        setScannerStatus(`QR decode handler failed: ${formatError(decodeErr)}`, "error");
      });
    },
    // html5-qrcode calls this on every decode attempt that didn't find a QR.
    // Counting these gives us a "camera pipeline is alive" heartbeat. We don't
    // log the message itself (it spams "No MultiFormat Readers..." on every
    // frame), just the count.
    () => {
      state.scanAttempts++;
    }
  );

  return scanner;
}

async function cleanupScannerAfterFailedStart() {
  const scanner = state.scanner;
  state.scanner = null;

  if (!scanner) return;

  try {
    // If start() failed, html5-qrcode may be in STARTING/TRANSITION.
    // Calling stop() during that state causes "Cannot transition to a new state".
    // Give it a breath, then clear. If clear fails, ignore and recreate a fresh instance.
    await sleep(350);
    await scanner.clear();
    debugLog("Cleared scanner instance after failed start");
  } catch (clearErr) {
    debugLog("Clear after failed start ignored", clearErr);
  }

  const reader = $("reader");
  if (reader) reader.innerHTML = "";
  await sleep(350);
}

// --- Scanner instrumentation & focus helpers (debug6) ---

function findScannerVideo() {
  const reader = $("reader");
  if (!reader) return null;
  return reader.querySelector("video");
}

function captureVideoTrack() {
  // html5-qrcode injects a <video> into #reader and binds the stream to it.
  // We need a handle on the track to (a) report actual resolution/focus mode
  // in the debug panel and (b) apply runtime focus constraints when the user
  // taps the video.
  const video = findScannerVideo();
  if (!video || !video.srcObject) {
    debugLog("captureVideoTrack: no video or srcObject yet");
    return;
  }
  const stream = video.srcObject;
  const track = stream.getVideoTracks?.()[0];
  if (!track) {
    debugLog("captureVideoTrack: no video track on stream");
    return;
  }
  state.videoTrack = track;
  try {
    const settings = track.getSettings?.() || {};
    const caps = track.getCapabilities?.() || {};
    state.videoSettings = settings;
    debugLog("Video track captured", {
      label: track.label,
      settings: {
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        focusMode: settings.focusMode,
        facingMode: settings.facingMode
      },
      capabilities: {
        focusMode: caps.focusMode,
        focusDistance: caps.focusDistance,
        torch: caps.torch,
        zoom: caps.zoom
      }
    });
  } catch (err) {
    debugLog("captureVideoTrack: getSettings/getCapabilities threw", err);
  }
}

async function tapToFocus(event) {
  // Best-effort focus nudge. iOS Safari mostly ignores focusMode constraints,
  // but tapping the video also pokes the native AF cycle indirectly because
  // the video element re-receives a pointer event.
  if (!state.videoTrack) {
    debugLog("tapToFocus: no track");
    return;
  }
  const caps = state.videoTrack.getCapabilities?.() || {};
  const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];

  // Try: single-shot focus, then continuous as a fallback. "manual" would
  // require focusDistance which we don't compute, so we skip it.
  const tryModes = [];
  if (modes.includes("single-shot")) tryModes.push("single-shot");
  if (modes.includes("continuous")) tryModes.push("continuous");
  if (modes.includes("auto")) tryModes.push("auto");

  if (!tryModes.length) {
    debugLog("tapToFocus: no supported focusMode capabilities", { caps });
    setScannerStatus("Tap-to-focus not supported on this device. Move closer/further to help focus.", "muted");
    return;
  }

  for (const mode of tryModes) {
    try {
      await state.videoTrack.applyConstraints({ advanced: [{ focusMode: mode }] });
      debugLog("tapToFocus applied", { mode });
      setScannerStatus(`Focus nudged (${mode}).`, "ok");
      return;
    } catch (err) {
      debugLog("tapToFocus mode failed", { mode, error: formatError(err) });
    }
  }
}

function attachTapToFocus() {
  const video = findScannerVideo();
  if (!video) return;
  // Inline cursor hint so the user knows the video is interactive.
  video.style.cursor = "crosshair";
  video.addEventListener("click", tapToFocus);
  video.addEventListener("touchstart", tapToFocus, { passive: true });
  debugLog("Tap-to-focus attached to video element");
}

function updateScannerTelemetry() {
  const el = $("scannerTelemetry");
  if (!el) return;

  const settings = state.videoSettings || {};
  const w = settings.width || "?";
  const h = settings.height || "?";
  const fr = settings.frameRate ? Math.round(settings.frameRate) : "?";
  const fm = settings.focusMode || "?";

  const idleMs = state.lastDecodeAt ? Date.now() - state.lastDecodeAt : null;
  const idleStr = idleMs === null
    ? "never"
    : idleMs < 1000 ? `${idleMs}ms ago` : `${Math.round(idleMs / 1000)}s ago`;

  el.innerHTML = `
    <strong>Resolution:</strong> ${w}×${h} @ ${fr}fps &nbsp;
    <strong>Focus:</strong> ${fm}<br>
    <strong>Scan attempts:</strong> ${state.scanAttempts} &nbsp;
    <strong>Decodes:</strong> ${state.scanSuccesses} &nbsp;
    <strong>Last decode:</strong> ${idleStr}
  `;
}

function startScannerHeartbeat() {
  stopScannerHeartbeat();
  // Refresh telemetry once per second. captureVideoTrack runs on the first tick
  // because html5-qrcode may not have inserted the <video> element by the time
  // scanner.start() resolves on slow devices.
  let firstTick = true;
  state.scanHeartbeat = setInterval(() => {
    if (firstTick || !state.videoTrack) {
      captureVideoTrack();
      if (state.videoTrack) attachTapToFocus();
      firstTick = false;
    }
    // Refresh settings each tick because focusMode can change after applyConstraints.
    if (state.videoTrack) {
      try {
        state.videoSettings = state.videoTrack.getSettings?.() || state.videoSettings;
      } catch {}
    }
    updateScannerTelemetry();
  }, 1000);
}

function stopScannerHeartbeat() {
  if (state.scanHeartbeat) {
    clearInterval(state.scanHeartbeat);
    state.scanHeartbeat = null;
  }
}

function resetScannerTelemetry() {
  state.scanAttempts = 0;
  state.scanSuccesses = 0;
  state.scanFailures = 0;
  state.lastDecodeAt = 0;
  state.videoTrack = null;
  state.videoSettings = null;
  const el = $("scannerTelemetry");
  if (el) el.innerHTML = "";
}

async function bumpResolutionOnLiveTrack() {
  // The trick: iOS Safari often refuses HD at getUserMedia time but grants it
  // when applyConstraints is called on the already-running track. We capture
  // the track first, then ask it to upgrade. Best-effort: failures are logged
  // and ignored, leaving the original (lower) resolution in place.
  captureVideoTrack();
  if (!state.videoTrack) {
    debugLog("bumpResolutionOnLiveTrack: no track yet, skipping");
    return;
  }

  const before = state.videoTrack.getSettings?.() || {};
  debugLog("Resolution before live bump", { width: before.width, height: before.height });

  if ((before.width || 0) >= 1280) {
    debugLog("Resolution already >=1280 wide, no bump needed");
    return;
  }

  const bumpAttempts = [
    { width: { min: 1280, ideal: 1920 }, height: { min: 720, ideal: 1080 } },
    { width: { ideal: 1920 }, height: { ideal: 1080 } },
    { width: { ideal: 1280 }, height: { ideal: 720 } }
  ];

  for (const constraints of bumpAttempts) {
    try {
      await state.videoTrack.applyConstraints(constraints);
      const after = state.videoTrack.getSettings?.() || {};
      state.videoSettings = after;
      debugLog("Resolution after live bump", {
        constraints,
        width: after.width,
        height: after.height
      });
      if ((after.width || 0) >= 1280) {
        setScannerStatus(`Upgraded camera to ${after.width}×${after.height}. Hold the QR inside the box.`, "ok");
        return;
      }
    } catch (err) {
      debugLog("Live resolution bump attempt failed", { constraints, error: formatError(err) });
    }
  }

  debugLog("Live resolution bump did not raise resolution; staying at acquisition default");
}

async function startScanner() {
  debugLog("Start Camera Scan clicked", {
    build: BUILD_ID,
    secureContext: window.isSecureContext,
    protocol: location.protocol,
    userAgent: navigator.userAgent,
    hasMediaDevices: !!navigator.mediaDevices,
    hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
    hasHtml5Qrcode: !!window.Html5Qrcode,
    hasBarcodeDetector: "BarcodeDetector" in window,
    scanStarting: state.scanStarting,
    hasScanner: !!state.scanner
  });

  if (state.scanStarting) {
    debugLog("Scanner start already in progress, ignoring duplicate click");
    return;
  }

  if (state.scanner || state.videoStream) {
    debugLog("Scanner already active, ignoring start click");
    return;
  }

  const reader = $("reader");
  if (!reader) {
    const message = "Scanner container #reader was not found in the page.";
    debugLog("Scanner startup failed", message);
    setScannerStatus(message, "error");
    return;
  }

  state.scanStarting = true;
  reader.innerHTML = "";
  resetScannerTelemetry();
  setScannerStatus("Starting camera…", "muted");
  $("startScanBtn").disabled = true;
  $("stopScanBtn").disabled = true;

  try {
    if (!window.isSecureContext) {
      throw new Error("Camera access requires HTTPS, localhost, or a trusted local context. Use your Cloudflare/Tailscale HTTPS URL on the phone.");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose camera access to this page. Try Safari on iPhone, and confirm camera permission is allowed for this site.");
    }

    if (!window.Html5Qrcode) {
      throw new Error("Html5Qrcode library is not loaded. Confirm libs/html5-qrcode.min.js loads before app.js and returns JavaScript, not a 404 page.");
    }

    let cameras = [];
    try {
      cameras = await Html5Qrcode.getCameras();
      debugLog("Html5Qrcode.getCameras result", cameras);
    } catch (cameraErr) {
      debugLog("Html5Qrcode.getCameras failed. Will try facingMode fallback.", cameraErr);
    }

    const scannerConfig = {
      // Lower fps = fewer but cleaner decode attempts. Counterintuitively this
      // detects faster on phones because each grab is sharper and the main
      // thread isn't saturated mid-decode.
      fps: 4,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        // Tighter scan box (70% vs 88%) prompts the user to fill the box with
        // the QR, which means the decoder works on a higher-resolution crop.
        const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.70);
        return { width: Math.max(220, size), height: Math.max(220, size) };
      },
      aspectRatio: 1.0,
      // Scanning a screen, not a mirror, so skip mirror-flipped decode attempts.
      disableFlip: true,
      // Use native BarcodeDetector where available (Chrome, recent Safari).
      // Native decoding is much faster than the ZXing JS port and more robust
      // to motion blur and angle. html5-qrcode falls back automatically on
      // browsers without it.
      experimentalFeatures: {
        useBarcodeDetector: true
      }
    };

    const cameraAttempts = [];

    // Build constraints with high-resolution video hints. We use min+ideal
    // (not bare ideal): iOS Safari treats a lone `ideal` as advisory and just
    // hands back VGA (480x640). Adding a `min` forces it to actually negotiate
    // a higher resolution or reject the constraint, at which point we fall
    // through to a softer attempt. Higher resolution = more pixels across the
    // QR = much better decode reliability, especially for paused QRs.
    const videoHints = {
      width: { min: 1280, ideal: 1920 },
      height: { min: 720, ideal: 1080 },
      // Continuous AF avoids the iOS autofocus-hunting problem where the camera
      // never settles on a high-contrast QR pattern. The whole 'advanced' array
      // is silently ignored by browsers that don't support these hints.
      advanced: [
        { focusMode: "continuous" },
        { focusMode: "auto" }
      ]
    };

    // Softer HD hint: ideal-only, used as a middle tier if the min-constrained
    // attempts get rejected outright by the UA.
    const videoHintsSoft = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [
        { focusMode: "continuous" },
        { focusMode: "auto" }
      ]
    };

    if (Array.isArray(cameras) && cameras.length) {
      const backCamera =
        cameras.find(c => /back|rear|environment/i.test(c.label || "")) ||
        cameras[cameras.length - 1];

      debugLog("Selected camera from list", backCamera);

      // Tier 1: deviceId + hard HD (min 1280). Tier 2: deviceId + soft HD
      // (ideal only). Tier 3: deviceId as a bare string (most compatible with
      // html5-qrcode when MediaTrackConstraints get rejected by the UA).
      cameraAttempts.push({
        label: "deviceId-hard-hd",
        config: { deviceId: { exact: backCamera.id }, ...videoHints }
      });
      cameraAttempts.push({
        label: "deviceId-soft-hd",
        config: { deviceId: { exact: backCamera.id }, ...videoHintsSoft }
      });
      cameraAttempts.push({
        label: "deviceId-string",
        config: backCamera.id
      });
    }

    cameraAttempts.push(
      {
        label: "facingMode-environment-hard-hd",
        config: { facingMode: { ideal: "environment" }, ...videoHints }
      },
      {
        label: "facingMode-environment-soft-hd",
        config: { facingMode: { ideal: "environment" }, ...videoHintsSoft }
      },
      { label: "facingMode-environment", config: { facingMode: "environment" } },
      { label: "facingMode-ideal-environment", config: { facingMode: { ideal: "environment" } } }
    );

    let lastErr = null;

    for (const attempt of cameraAttempts) {
      try {
        debugLog("Trying camera start", attempt);
        await createAndStartHtml5Scanner(attempt.config, scannerConfig);
        lastErr = null;
        debugLog("Scanner started successfully", attempt);
        break;
      } catch (err) {
        lastErr = err;
        debugLog("Camera start attempt failed", {
          attempt,
          error: formatError(err),
          raw: safeStringify(err)
        });
        await cleanupScannerAfterFailedStart();
      }
    }

    if (lastErr) throw lastErr;

    state.scanStarting = false;
    $("stopScanBtn").disabled = false;
    $("startScanBtn").disabled = true;
    // Give html5-qrcode a moment to insert the <video> element and bind the
    // stream, then attempt the live-track resolution upgrade (iOS trick).
    await sleep(400);
    await bumpResolutionOnLiveTrack();
    startScannerHeartbeat();
    setScannerStatus("Camera running. Tap the video to focus. Hold the QR inside the box.", "ok");
  } catch (err) {
    const message = formatError(err);
    debugLog("Scanner startup failed", { message, raw: safeStringify(err) });

    state.scanStarting = false;
    await stopScanner({ silent: true, force: true });
    $("startScanBtn").disabled = false;
    $("stopScanBtn").disabled = true;
    setScannerStatus(`Camera failed: ${message}`, "error");
  }
}

async function stopScanner(options = {}) {
  debugLog("stopScanner called", options);

  state.scanStarting = false;
  stopScannerHeartbeat();

  if (state.scanner) {
    const scanner = state.scanner;
    state.scanner = null;

    try {
      if (!options.force) {
        await scanner.stop();
        debugLog("Scanner stopped");
      }
    } catch (stopErr) {
      debugLog("Scanner stop ignored", stopErr);
    }

    try {
      await scanner.clear();
      debugLog("Scanner cleared");
    } catch (clearErr) {
      debugLog("Scanner clear ignored", clearErr);
    }
  }

  if (state.scanTimer) {
    cancelAnimationFrame(state.scanTimer);
    state.scanTimer = null;
  }

  if (state.videoStream) {
    state.videoStream.getTracks().forEach(track => track.stop());
    state.videoStream = null;
  }

  const reader = $("reader");
  if (reader) reader.innerHTML = "";
  state.videoTrack = null;
  state.videoSettings = null;
  $("startScanBtn").disabled = false;
  $("stopScanBtn").disabled = true;
  if (!options.silent) setScannerStatus("Scanner stopped.", "muted");
}

function downloadRebuiltFile() {
  if (!state.rebuiltBlob || !state.activeTransfer) return;
  const url = URL.createObjectURL(state.rebuiltBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = state.activeTransfer.name || "rebuilt-file";
  a.click();
  URL.revokeObjectURL(url);
}

async function copyOutput() {
  if (!state.rebuiltText) return;
  await navigator.clipboard.writeText(state.rebuiltText);
  $("copyBtn").textContent = "Copied";
  setTimeout(() => $("copyBtn").textContent = "Copy Text", 900);
}

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

$("fileInput").addEventListener("change", () => {
  const file = $("fileInput").files[0];
  if (file) $("fileName").value = file.name;
});
$("generateBtn").addEventListener("click", () => generateFrames().catch(err => alert(err.message)));
$("stopBtn").addEventListener("click", stopAnimation);
$("pausePlayBtn").addEventListener("click", togglePausePlay);
$("prevFrameBtn").addEventListener("click", previousFrame);
$("nextFrameBtn").addEventListener("click", nextFrame);
$("prevSectionBtn")?.addEventListener("click", prevSection);
$("nextSectionBtn")?.addEventListener("click", nextSection);
$("displayModeBtn").addEventListener("click", openDisplayMode);
$("exitDisplayModeBtn").addEventListener("click", () => toggleDisplayMode(false));
$("startScanBtn").addEventListener("click", () => startScanner());
$("stopScanBtn").addEventListener("click", () => stopScanner().catch(err => alert(errorToMessage(err))));
$("resetScanBtn").addEventListener("click", resetDecode);
$("downloadBtn").addEventListener("click", downloadRebuiltFile);
$("copyBtn").addEventListener("click", copyOutput);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.displayMode) toggleDisplayMode(false);
  if (event.key === "ArrowLeft") previousFrame();
  if (event.key === "ArrowRight") nextFrame();
  // Up/Down switch sections — works in fullscreen Large Display Mode where the
  // on-screen section buttons are hidden.
  if (event.key === "ArrowUp" && document.activeElement?.tagName !== "TEXTAREA") {
    event.preventDefault();
    prevSection();
  }
  if (event.key === "ArrowDown" && document.activeElement?.tagName !== "TEXTAREA") {
    event.preventDefault();
    nextSection();
  }
  if (event.key === " " && document.activeElement?.tagName !== "TEXTAREA") {
    event.preventDefault();
    togglePausePlay();
  }
});


debugLog("App boot", {
  build: BUILD_ID,
  href: location.href,
  secureContext: window.isSecureContext,
  hasQRCode: !!window.QRCode,
  hasPako: !!window.pako,
  hasHtml5Qrcode: !!window.Html5Qrcode,
  hasMediaDevices: !!navigator.mediaDevices,
  hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia
});

if (location.hash === "#display") {
  // Clean up old bookmarked/hash state from earlier builds.
  history.replaceState(null, "", location.pathname + location.search);
}
if (wantsDisplayMode()) {
  toggleDisplayMode(true);
}
