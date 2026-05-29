const BUILD_ID = "debug10-2026-05-27";
const $ = (id) => document.getElementById(id);

const state = {
  // AQR2 frame generator state (replaces the old fixed frames[]/frameIndex loop)
  ltGenerator: null,        // { nextFrame(), K, transferId, blockSize, totalBytes }
  frameSeq: 0,              // monotonically increasing count of frames emitted so far
  lastBuiltFrame: "",       // most recently rendered AQR2 frame string
  intervalId: null,
  scanner: null,
  videoStream: null,
  scanTimer: null,
  detector: null,
  decoder: null,            // LTDecoder instance for the on-page decoder (web-side decode for testing)
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

// Build an LT frame generator that emits successive AQR2 frame strings.
// `frameSeed` is incremented per frame; seeds 1, 2, 3, ... feed mulberry32.
function makeLTGenerator({ id, alg, K, fileHash, totalBytes, name, mime, blocks }) {
  let seed = 0;
  return {
    K,
    transferId: id,
    blockSize: blocks[0].length,
    totalBytes,
    nextFrame() {
      seed = (seed + 1) >>> 0;
      const rng = mulberry32(seed);
      const degree = sampleDegree(rng, K);
      const indices = pickIndices(rng, K, degree);
      const xor = xorBlocks(blocks, indices);
      const xorB64 = base64UrlEncode(xor);
      // Wire format AQR2:
      //   AQR2|id|seed|K|totalBytes|alg|fileHash|nameB64|mimeB64|xorPayloadB64
      return [
        "AQR2",
        id,
        seed,
        K,
        totalBytes,
        alg,
        fileHash,
        encodeString(name),
        encodeString(mime),
        xorB64
      ].join("|");
    }
  };
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

function buildAQR2Frame(meta, seed, xorB64) {
  // Wire format:
  //   AQR2|id|seed|K|totalBytes|alg|fileHash|nameB64|mimeB64|xorPayloadB64
  return [
    "AQR2",
    meta.id,
    seed,
    meta.K,
    meta.totalBytes,
    meta.alg,
    meta.fileHash,
    encodeString(meta.name),
    encodeString(meta.mime),
    xorB64
  ].join("|");
}

function parseFrame(decodedText) {
  // Only AQR2 is accepted. Anything else (random QR, old AQR1, JSON, gibberish)
  // returns null and the caller drops it.
  if (!decodedText.startsWith("AQR2|")) return null;
  const parts = decodedText.split("|");
  if (parts.length !== 10) return null;
  const [, id, seedStr, KStr, totalBytesStr, alg, fileHash, nameB64, mimeB64, xorB64] = parts;
  const seed = Number(seedStr);
  const K = Number(KStr);
  const totalBytes = Number(totalBytesStr);
  if (!Number.isFinite(seed) || !Number.isFinite(K) || !Number.isFinite(totalBytes)) return null;
  if (seed <= 0 || K <= 0 || totalBytes <= 0) return null;
  return {
    qrt: "aqr-transfer",
    v: 3,
    id,
    seed,
    K,
    totalBytes,
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

  // `K` is now the number of source blocks, not the chunk character size. The
  // dropdown is repurposed: lower K = bigger blocks per frame (denser QR, fewer
  // frames needed), higher K = smaller blocks per frame (sparser QR, more
  // frames needed but each QR is much easier to scan).
  const K = Number($("chunkSize").value);
  if (!Number.isFinite(K) || K < 2) throw new Error("K must be at least 2.");

  const id = randomId();
  const fileHash = await sha256Hex(bytes);
  const alg = useCompression ? "gzip" : "raw";

  const { blocks, blockSize } = splitIntoKBlocks(processedBytes, K);
  state.ltGenerator = makeLTGenerator({
    id,
    alg,
    K,
    fileHash,
    totalBytes: processedBytes.length,
    name,
    mime,
    blocks
  });
  state.frameSeq = 0;
  state.lastBuiltFrame = "";

  // Sanity check the round-trip with a quick in-page LT decode so we catch any
  // PRNG/encoding drift before the phone even sees it. ~K*1.5 frames is
  // virtually always enough.
  await sanityCheckLTRoundTrip(state.ltGenerator, processedBytes, K);

  // Encode-side stats. "Frames" is now "frames to typically decode" — the LT
  // overhead factor in practice for ideal soliton is ~1.5-2x for small K.
  const xorPayloadChars = Math.ceil(blockSize * 4 / 3) + 4;  // rough b64url size + a bit
  const sampleFrame = state.ltGenerator.nextFrame();         // we'll re-render this below
  state.lastBuiltFrame = sampleFrame;
  state.frameSeq = 1;
  $("encodeStats").innerHTML = `
    Original: <strong>${bytes.length.toLocaleString()}</strong> bytes<br>
    Processed (post-gzip): <strong>${processedBytes.length.toLocaleString()}</strong> bytes<br>
    K (source blocks): <strong>${K}</strong><br>
    Block size: <strong>${blockSize.toLocaleString()}</strong> bytes<br>
    Sample frame length: <strong>${sampleFrame.length.toLocaleString()}</strong> chars<br>
    Algorithm: <strong>${alg}</strong><br>
    QR settings: <strong>ECC M, margin 2, AQR2 / LT</strong><br>
    <em>Frames are generated on the fly. Decoder finishes after ~${Math.ceil(K * 1.5)}–${Math.ceil(K * 2)} unique scans.</em>
  `;
  $("transferId").textContent = `Transfer ID: ${id}`;

  await renderCurrentFrame();
  startAnimation();
}

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
  if (!state.ltGenerator || !state.lastBuiltFrame) {
    wrap.textContent = "QR frames will appear here";
    wrap.classList.add("empty");
    return;
  }

  wrap.classList.remove("empty");
  const canvas = document.createElement("canvas");
  canvas.className = "qr-canvas";
  wrap.appendChild(canvas);
  await QRCode.toCanvas(canvas, state.lastBuiltFrame, QR_OPTIONS);
  $("frameCounter").textContent = `Frame seq ${state.frameSeq}`;
}

function advanceFrame() {
  // Honor the "Repeat each frame" dropdown by only emitting a new LT frame
  // every `hold` ticks. Repeating gives the camera multiple decode windows on
  // the same QR, which is what makes scanning consistently fast.
  const hold = Number($("frameHold").value || 1);
  if (!state.ltGenerator) return;
  if (state.frameSeq % hold === 0 || !state.lastBuiltFrame) {
    state.lastBuiltFrame = state.ltGenerator.nextFrame();
  }
  state.frameSeq++;
  renderCurrentFrame();
}

function startAnimation() {
  if (!state.ltGenerator) return;
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
  if (!state.ltGenerator) return;
  if (state.intervalId) stopAnimation();
  else startAnimation();
}

// Previous/Next in LT mode aren't "go back to frame N" — there's no frame N to
// go back to. Instead, both buttons just emit a fresh LT frame so the user can
// step through manually. This matches the AQR1 mental model closely enough.
async function previousFrame() {
  if (!state.ltGenerator) return;
  stopAnimation();
  state.lastBuiltFrame = state.ltGenerator.nextFrame();
  state.frameSeq++;
  await renderCurrentFrame();
}

async function nextFrame() {
  if (!state.ltGenerator) return;
  stopAnimation();
  state.lastBuiltFrame = state.ltGenerator.nextFrame();
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
  state.decoder = null;
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

  // New transfer? Reset and adopt its metadata.
  if (!state.activeTransfer || state.activeTransfer.id !== payload.id) {
    resetDecode();
    state.lastDecoded = decodedText;
    state.activeTransfer = {
      id: payload.id,
      K: payload.K,
      totalBytes: payload.totalBytes,
      name: payload.name,
      mime: payload.mime,
      alg: payload.alg,
      fileHash: payload.fileHash
    };
    // Decoder needs the actual block size, which we infer from this first frame.
    const firstXor = base64UrlDecode(payload.xorB64);
    state.decoder = new LTDecoder({
      K: payload.K,
      blockSize: firstXor.length,
      totalBytes: payload.totalBytes
    });
  }

  if (payload.id !== state.activeTransfer.id) return;
  if (!state.decoder) return;

  const xor = base64UrlDecode(payload.xorB64);
  state.decoder.addEquation(payload.seed, xor);
  updateDecodeProgress();

  if (state.decoder.isComplete()) {
    await rebuildTransfer();
  }
}

function updateDecodeProgress() {
  const meta = state.activeTransfer;
  const dec = state.decoder;
  if (!meta || !dec) return;
  const pct = Math.round((dec.resolvedCount / dec.K) * 100);
  $("meterBar").style.width = `${pct}%`;

  $("decodeStats").innerHTML = `
    Transfer ID: <strong>${meta.id}</strong><br>
    File: <strong>${meta.name}</strong><br>
    Blocks resolved: <strong>${dec.resolvedCount} / ${dec.K}</strong><br>
    Frames seen: <strong>${dec.equationsSeen}</strong><br>
    Pending equations: <strong>${dec.pending.length}</strong><br>
    Algorithm: <strong>${meta.alg}</strong>
  `;
  $("missingChunks").textContent = dec.isComplete()
    ? "All blocks resolved."
    : `${dec.K - dec.resolvedCount} blocks still unknown. Keep scanning.`;
}

async function rebuildTransfer() {
  const meta = state.activeTransfer;
  const dec = state.decoder;
  if (!meta || !dec || !dec.isComplete()) return;

  let bytes = dec.rebuild();
  if (!bytes) {
    $("missingChunks").textContent = "Decoder reported complete but rebuild returned null.";
    return;
  }

  if (meta.alg === "gzip") {
    try {
      bytes = pako.ungzip(bytes);
    } catch (err) {
      $("missingChunks").textContent = `Gunzip failed: ${formatError(err)}`;
      return;
    }
  }

  const finalHash = await sha256Hex(bytes);
  if (finalHash !== meta.fileHash) {
    $("missingChunks").textContent = "Checksum failed. Reset and try again.";
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
  $("decodeStats").innerHTML += `<br><span class="ok">Checksum passed. Transfer complete.</span>`;
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
