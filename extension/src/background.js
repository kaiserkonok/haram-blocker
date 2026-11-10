// Haram Blocker — background service worker.
// Keeps the GPU helper running (Chrome starts it through native messaging)
// and passes audio between pages and the helper.

const HOST = "com.haram_blocker.cleaner";
const DEFAULTS = {
  sites: [],
  channels: [],
  lipSync: true,
  imageMode: "off", // "off" | "male" (hide women) | "female" (hide men)
  imageStyle: "color", // "color" | "blur"
  imageColor: "#000000",
  imageBlur: 40,
};

let native = null;
let helper = { state: "stopped" };
let lastPong = null;
let retryMs = 2000;
let retryTimer = null;

const pages = new Map(); // key -> { port, tabId, sids: Set, stats }
let nextKey = 1;

// ---------------------------------------------------------------- helper
function connectHelper() {
  if (native) return;
  clearTimeout(retryTimer);
  helper = { state: "starting" };
  try {
    native = chrome.runtime.connectNative(HOST);
  } catch (e) {
    helper = { state: "error", error: String(e) };
    scheduleRetry();
    return;
  }
  native.onMessage.addListener(onHelperMessage);
  native.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
    native = null;
    helper = { state: "error", error: err || "The helper program stopped." };
    imagesReady = null;
    for (const [, w] of imgWaiters) w.reject(new Error("helper stopped"));
    imgWaiters.clear();
    scheduleRetry();
  });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connectHelper, retryMs);
  retryMs = Math.min(retryMs * 2, 60000);
}

function onHelperMessage(m) {
  if (m.t === "out") {
    const i = m.sid.indexOf(":");
    const page = pages.get(m.sid.slice(0, i));
    if (page) {
      m.sid = Number(m.sid.slice(i + 1));
      page.port.postMessage(m);
    }
  } else if (m.t === "imgres") {
    const w = imgWaiters.get(m.id);
    if (w) {
      imgWaiters.delete(m.id);
      w.resolve({ hide: m.hide, why: m.why });
    }
  } else if (m.t === "imgready") {
    if (imagesReadyResolve) imagesReadyResolve(!m.error);
  } else if (m.t === "status") {
    helper = m;
    if (m.state === "ready") {
      retryMs = 2000;
      warmImages();
    }
  } else if (m.t === "pong") {
    lastPong = { ...m, at: Date.now() };
  }
}

setInterval(() => {
  if (native && helper.state === "ready") native.postMessage({ t: "ping" });
  warmImages(); // safety net: load the image models if they're needed but not loaded
}, 5000);

// ---------------------------------------------------------------- pages
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "page") return;
  const key = String(nextKey++);
  const page = { port, tabId: port.sender && port.sender.tab ? port.sender.tab.id : -1, sids: new Set(), stats: null };
  pages.set(key, page);
  connectHelper();

  port.onMessage.addListener((m) => {
    if (m.t === "chunk") {
      // No helper -> nothing comes back -> the page plays silence.
      if (!native || helper.state !== "ready") return;
      page.sids.add(m.sid);
      m.sid = key + ":" + m.sid;
      native.postMessage(m);
    } else if (m.t === "stats") {
      page.stats = { ...m, at: Date.now() };
    }
  });
  port.onDisconnect.addListener(() => {
    pages.delete(key);
    if (native) for (const sid of page.sids) native.postMessage({ t: "close", sid: key + ":" + sid });
  });
});

// ---------------------------------------------------------------- images
let settings = { ...DEFAULTS };
chrome.storage.local.get(DEFAULTS).then((v) => {
  settings = v;
  syncImageCss();
  warmImages();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  chrome.storage.local.get(DEFAULTS).then((v) => {
    const modeChanged = v.imageMode !== settings.imageMode;
    settings = v;
    if (modeChanged) {
      syncImageCss();
      warmImages();
    }
  });
});

// images.css must load before the page draws, so it is registered as a
// content script only while image hiding is on.
async function syncImageCss() {
  const id = "hb-images-css";
  try {
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (settings.imageMode !== "off" && !have.length) {
      await chrome.scripting.registerContentScripts([
        {
          id,
          css: ["src/images.css"],
          matches: ["<all_urls>"],
          runAt: "document_start",
          allFrames: true,
          matchOriginAsFallback: true,
          persistAcrossSessions: true,
        },
      ]);
    } else if (settings.imageMode === "off" && have.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
    }
  } catch (e) {
    console.warn("image css registration failed", e);
  }
}

// Load the image models on the GPU only when the feature is on.
let imagesReady = null;
let imagesReadyResolve = null;
function warmImages() {
  if (settings.imageMode === "off" || !native || helper.state !== "ready" || imagesReady) return;
  imagesReady = new Promise((r) => (imagesReadyResolve = r));
  native.postMessage({ t: "imgwarm" });
}

const imgWaiters = new Map(); // id -> { resolve, reject }
let nextImgId = 1;
const imgCache = new Map(); // "hide|source" -> { hide, why }
const imgPending = new Map();
const IMG_CACHE_MAX = 5000;

function cacheKey(hide, src) {
  if (src.length > 300) {
    // data: URLs can be huge; a cheap hash is enough as a key.
    let h = 0;
    for (let i = 0; i < src.length; i += 7) h = (h * 31 + src.charCodeAt(i)) | 0;
    src = src.slice(0, 100) + "#" + h + ":" + src.length;
  }
  return hide + "|" + src;
}

function toB64(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.toBase64) return u8.toBase64();
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// SVG images are drawn in a hidden extension page (workers can't decode SVG).
let offscreenCreating = null;
async function rasterSvg(text) {
  if (!(await chrome.offscreen.hasDocument())) {
    offscreenCreating =
      offscreenCreating ||
      chrome.offscreen
        .createDocument({
          url: "src/offscreen.html",
          reasons: ["DOM_PARSER"],
          justification: "Draw SVG images so they can be checked",
        })
        .finally(() => (offscreenCreating = null));
    await offscreenCreating;
  }
  const r = await chrome.runtime.sendMessage({ target: "offscreen", t: "raster", svg: text });
  if (!r || !r.data) throw new Error("SVG could not be drawn: " + (r && r.error));
  return { data: r.data };
}

// Download an image the page wouldn't let us read, shrink it, JPEG it.
async function fetchSmall(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  if (/svg/i.test(blob.type) || /\.svg([?#]|$)/i.test(url)) return rasterSvg(await blob.text());
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height)); // helper: vision.MAX_SIDE
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  if (Math.min(bmp.width, bmp.height) < 40) return { tiny: true };
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; // transparent parts on white, not black
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const jpeg = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return { data: toB64(await jpeg.arrayBuffer()) };
}

async function checkImage(src, data, hide) {
  const key = cacheKey(hide, src);
  if (imgCache.has(key)) return imgCache.get(key);
  if (imgPending.has(key)) return imgPending.get(key);
  const p = (async () => {
    if (!data) {
      const f = await fetchSmall(src);
      if (f.tiny) return { hide: false, why: "tiny" };
      data = f.data;
    }
    warmImages();
    if (!imagesReady || !(await imagesReady)) throw new Error("image models not ready");
    const r = await new Promise((resolve, reject) => {
      const id = nextImgId++;
      imgWaiters.set(id, { resolve, reject });
      native.postMessage({ t: "img", id, hide, data });
      setTimeout(() => {
        if (imgWaiters.delete(id)) reject(new Error("timeout"));
      }, 20000);
    });
    imgCache.set(key, r);
    if (imgCache.size > IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
    return r;
  })();
  imgPending.set(key, p);
  try {
    return await p;
  } finally {
    imgPending.delete(key);
  }
}

// ---------------------------------------------------------------- popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.t === "img") {
    if (settings.imageMode === "off") {
      sendResponse({ hide: false });
      return;
    }
    const hide = settings.imageMode === "male" ? "female" : "male";
    checkImage(msg.url, msg.data, hide).then(
      (r) => sendResponse({ hide: r.hide }),
      // Couldn't check (helper starting, download failed): stay hidden.
      (e) => sendResponse({ hide: true, retry: helper.state !== "ready" || /not ready|stopped|timeout/.test(String(e)) })
    );
    return true;
  }
  if (msg.t === "getStatus") {
    const tabStats = [...pages.values()]
      .filter((p) => p.tabId === msg.tabId && p.stats && Date.now() - p.stats.at < 5000)
      .map((p) => p.stats);
    sendResponse({ helper, lastPong, tabStats });
  } else if (msg.t === "restartHelper") {
    if (native) native.disconnect();
    native = null;
    retryMs = 2000;
    connectHelper();
    sendResponse({ ok: true });
  }
});

// Fill in settings that don't exist yet (never overwrite the user's
// choices) and remove malformed entries saved by older versions.
async function repairSettings() {
  const have = await chrome.storage.local.get(null);
  const fix = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in have)) fix[k] = v;
  if (Array.isArray(have.channels)) {
    const good = have.channels.filter((c) => c && typeof c.id === "string" && c.id);
    if (good.length !== have.channels.length) fix.channels = good;
  }
  if (Array.isArray(have.sites)) {
    const good = have.sites.filter((x) => typeof x === "string" && x);
    if (good.length !== have.sites.length) fix.sites = good;
  }
  if (Object.keys(fix).length) await chrome.storage.local.set(fix);
}
chrome.runtime.onInstalled.addListener(repairSettings);
repairSettings();

// Start the helper as soon as Chrome starts, so the AI is warm before the
// first video.
connectHelper();
