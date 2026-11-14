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
  imageLevel: "strict", // "strict" (fewest leaks) | "balanced" (hides fewer harmless images)
  imageColor: "#000000",
  imageBlur: 40,
  blockedSites: [], // "example.com" or "example.com/some/path"
  blockAdult: true, // the built-in adult-site list
  adultAllowed: [], // sites the user unblocked from the built-in list
  slipped: false, // unblocked something; the next blocked page starts with mercy
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

async function checkImage(src, data, hide, level) {
  const key = cacheKey(hide + ":" + level, src);
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
      native.postMessage({ t: "img", id, hide, level, data });
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

// ---------------------------------------------------------------- site blocker
// Blocked sites are redirected by Chrome itself (declarativeNetRequest)
// before any of their content loads, to blocker/blocked.html, which carries
// the original address after "#". The built-in adult list is a static rule
// set (rules/adult.json); the user's own sites are dynamic rules.

const UNBLOCK_WAIT_MS = 30000;
const UNBLOCK_SENTENCE = "I am choosing my desire over what I know is better.";
const USER_RULE_BASE = 100000; // ids of the user's block rules
const ALLOW_RULE_BASE = 200000; // ids of sites unblocked from the adult list

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+(xn--[a-z0-9-]+|[a-z]{2,63})$/;

// "https://www.Example.com/Shorts/abc?x" -> "example.com/shorts/abc";
// "example.com" stays "example.com". null if it isn't a site.
function normalizeSite(input) {
  let t = String(input || "").trim().toLowerCase();
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(t)) t = "http://" + t;
  let u;
  try {
    u = new URL(t);
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (!HOST_RE.test(host)) return null;
  const path = decodeURI(u.pathname).replace(/\/+$/, "");
  return path ? host + path : host;
}

function splitSite(site) {
  const i = site.indexOf("/");
  return i < 0 ? { host: site, path: "" } : { host: site.slice(0, i), path: site.slice(i) };
}

const escapeRegex = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Does an address fall under a blocked site? (host and its subdomains; for a
// path, that path and everything below it)
function siteMatches(site, url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const { host, path } = splitSite(site);
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (h !== host && !h.endsWith("." + host)) return false;
  if (!path) return true;
  let p;
  try {
    p = decodeURI(u.pathname).toLowerCase();
  } catch (e) {
    p = u.pathname.toLowerCase();
  }
  return p === path || p.startsWith(path + "/");
}

function blockedPage(params, url) {
  return chrome.runtime.getURL("blocker/blocked.html") + "?" + new URLSearchParams(params) + (url ? "#" + url : "");
}

let blockSync = Promise.resolve();
function syncBlockRules() {
  blockSync = blockSync.then(applyBlockRules, applyBlockRules);
  return blockSync;
}

async function applyBlockRules() {
  const s = await chrome.storage.local.get(DEFAULTS);
  const sites = cleanSites(s.blockedSites);
  const allowed = cleanSites(s.adultAllowed).filter((x) => !x.includes("/"));
  const base = "chrome-extension://" + chrome.runtime.id + "/blocker/blocked.html?";
  const addRules = [];
  sites.forEach((site, i) => {
    const { host, path } = splitSite(site);
    addRules.push({
      id: USER_RULE_BASE + i,
      priority: 3, // beats the adult list and its exceptions
      action: {
        type: "redirect",
        redirect: { regexSubstitution: base + new URLSearchParams({ site }) + "#\\0" },
      },
      condition: {
        requestDomains: [host],
        regexFilter: path ? "^[a-z]+://[^/]+" + escapeRegex(encodeURI(path)) + "([/?#].*)?$" : "^.+$",
        isUrlFilterCaseSensitive: false,
        resourceTypes: ["main_frame", "sub_frame"],
      },
    });
  });
  allowed.forEach((host, i) => {
    addRules.push({
      id: ALLOW_RULE_BASE + i,
      priority: 2, // beats the adult list (priority 1)
      action: { type: "allow" },
      condition: { requestDomains: [host], resourceTypes: ["main_frame", "sub_frame"] },
    });
  });
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules });
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    s.blockAdult ? { enableRulesetIds: ["adult"] } : { disableRulesetIds: ["adult"] }
  );
  // Tabs already showing a site that is now blocked move to the blocked page.
  for (const tab of await chrome.tabs.query({})) enforceTab(tab.id, tab.url, sites);
  blockedSitesCache = sites;
}

let blockedSitesCache = [];
function enforceTab(tabId, url, sites = blockedSitesCache) {
  if (!url || url.startsWith(chrome.runtime.getURL(""))) return false;
  const site = sites.find((x) => siteMatches(x, url));
  if (!site) return false;
  chrome.tabs.update(tabId, { url: blockedPage({ site }, url) }).catch(() => {});
  return true;
}

// Sites like YouTube change page without loading a new one (Shorts from a
// video page). Chrome's blocking doesn't see that; catch the new address.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) enforceTab(tabId, info.url);
});

function cleanSites(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const n = normalizeSite(x);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

// Unblocking takes a pause and a typed sentence. The page shows the verses
// and the countdown; the rule is enforced here.
// Start times live in session storage: the worker may be stopped while the
// page counts down.
async function unblockStartTime(target) {
  const k = "unblockStart:" + target;
  return (await chrome.storage.session.get(k))[k];
}
function sameSentence(a) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[’‘]/g, "'").replace(/[.\s]+/g, " ").trim();
  return norm(a) === norm(UNBLOCK_SENTENCE);
}

async function unblock(target) {
  const s = await chrome.storage.local.get(DEFAULTS);
  if (target === "adult-list") {
    await chrome.storage.local.set({ blockAdult: false, slipped: true });
  } else if (target.startsWith("site:")) {
    const site = target.slice(5);
    await chrome.storage.local.set({ blockedSites: cleanSites(s.blockedSites).filter((x) => x !== site), slipped: true });
  } else if (target.startsWith("adult:")) {
    const host = normalizeSite(target.slice(6));
    if (!host) throw new Error("bad site");
    await chrome.storage.local.set({ adultAllowed: [...cleanSites(s.adultAllowed), host.split("/")[0]], slipped: true });
  } else {
    throw new Error("unknown target");
  }
  await syncBlockRules();
}

function blockerMessage(msg, sendResponse) {
  if (msg.t === "block") {
    const site = normalizeSite(msg.site);
    if (!site) {
      sendResponse({ error: "That doesn't look like a website address." });
      return;
    }
    chrome.storage.local.get(DEFAULTS).then(async (s) => {
      const sites = cleanSites(s.blockedSites);
      if (!sites.includes(site)) sites.push(site);
      await chrome.storage.local.set({ blockedSites: sites });
      await syncBlockRules();
      sendResponse({ ok: true, site });
    });
  } else if (msg.t === "blockAdult") {
    chrome.storage.local.set({ blockAdult: true }).then(syncBlockRules).then(() => sendResponse({ ok: true }));
  } else if (msg.t === "unblockStart") {
    chrome.storage.session
      .set({ ["unblockStart:" + msg.target]: Date.now() })
      .then(() => sendResponse({ waitMs: UNBLOCK_WAIT_MS, sentence: UNBLOCK_SENTENCE }));
  } else if (msg.t === "unblockFinish") {
    unblockStartTime(msg.target).then(async (t0) => {
      if (!t0 || Date.now() - t0 < UNBLOCK_WAIT_MS - 250) {
        sendResponse({ error: "Please wait until the countdown ends." });
      } else if (!sameSentence(msg.text)) {
        sendResponse({ error: "The sentence doesn't match." });
      } else {
        await chrome.storage.session.remove("unblockStart:" + msg.target);
        unblock(msg.target).then(
          () => sendResponse({ ok: true }),
          (e) => sendResponse({ error: String(e.message || e) })
        );
      }
    });
  }
}

// ---------------------------------------------------------------- popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (["block", "blockAdult", "unblockStart", "unblockFinish"].includes(msg.t)) {
    blockerMessage(msg, sendResponse);
    return true;
  }
  if (msg.t === "img") {
    if (settings.imageMode === "off") {
      sendResponse({ hide: false });
      return;
    }
    const hide = settings.imageMode === "male" ? "female" : "male";
    checkImage(msg.url, msg.data, hide, settings.imageLevel === "balanced" ? "balanced" : "strict").then(
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
  for (const k of ["blockedSites", "adultAllowed"]) {
    if (k in have && JSON.stringify(cleanSites(have[k])) !== JSON.stringify(have[k])) fix[k] = cleanSites(have[k]);
  }
  if (Object.keys(fix).length) await chrome.storage.local.set(fix);
}
async function startup() {
  await repairSettings();
  await syncBlockRules();
}
chrome.runtime.onInstalled.addListener(startup);
chrome.runtime.onStartup.addListener(startup);
startup();

// Start the helper as soon as Chrome starts, so the AI is warm before the
// first video.
connectHelper();
