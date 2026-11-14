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
  neededSites: [], // blocked sites the user sometimes needs (can be opened for one visit)
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
//
// Rule priorities (highest wins):
//   6  allow  a site the user unblocked from the adult list
//   5  block  the adult list (rules/adult.json)
//   4  allow  one visit to a "needed" site, in specific tabs (session rule)
//   3  block  the user's own sites
// So a "needed" visit can never open a site on the adult list.

// What it takes to loosen a block: a pause and a typed sentence.
const LOOSEN = {
  // remove a block / turn the adult list off / unblock one adult site
  unblock: { waitMs: 30000, sentence: "I am choosing my desire over what I know is better." },
  // open a "needed" site in this tab, for this visit
  need: { waitMs: 10000, sentence: "I am opening this site for a real need, and I will not look at anything haram. Allah sees me." },
  // mark an existing block as "I sometimes need this site"
  mark: { waitMs: 30000, sentence: "I really need this site, and I will only use it for that need." },
};
const CHECKIN_MS = 60 * 60 * 1000; // "Still working?" during a needed visit
const USER_RULE_BASE = 100000; // the user's block rules
const ALLOW_RULE_BASE = 200000; // sites unblocked from the adult list
const VISIT_RULE_BASE = 300000; // one-visit openings of needed sites (session rules)

function loosenKind(target) {
  if (target.startsWith("need:")) return "need";
  if (target.startsWith("need-mark:")) return "mark";
  return "unblock";
}

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

function onHost(host, url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    return h === host || h.endsWith("." + host);
  } catch (e) {
    return false;
  }
}

// Does an address fall under a blocked site? (host and its subdomains; for a
// path, that path and everything below it)
function siteMatches(site, url) {
  const { host, path } = splitSite(site);
  if (!onHost(host, url)) return false;
  if (!path) return true;
  const raw = new URL(url).pathname;
  let p;
  try {
    p = decodeURI(raw).toLowerCase();
  } catch (e) {
    p = raw.toLowerCase();
  }
  return p === path || p.startsWith(path + "/");
}

function blockedPage(params, url) {
  return chrome.runtime.getURL("blocker/blocked.html") + "?" + new URLSearchParams(params) + (url ? "#" + url : "");
}

function cleanSites(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const n = normalizeSite(x);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
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
      priority: 3,
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
      priority: 6,
      action: { type: "allow" },
      condition: { requestDomains: [host], resourceTypes: ["main_frame", "sub_frame"] },
    });
  });
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules });
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    s.blockAdult ? { enableRulesetIds: ["adult"] } : { disableRulesetIds: ["adult"] }
  );
  blockedSitesCache = sites;
  // A needed visit ends if its site is no longer blocked as "needed".
  const needed = cleanSites(s.neededSites).filter((x) => sites.includes(x));
  await withVisits(async (visits) => {
    for (const [id, v] of Object.entries(visits)) if (!needed.includes(v.site)) await endVisit(visits, id, false);
  });
  // Tabs already showing a site that is now blocked move to the blocked page.
  for (const tab of await chrome.tabs.query({})) enforceTab(tab.id, tab.url);
}

let blockedSitesCache = [];
function enforceTab(tabId, url) {
  if (!url || url.startsWith(chrome.runtime.getURL(""))) return false;
  const site = blockedSitesCache.find((x) => siteMatches(x, url));
  if (!site || visitOfTab(tabId, url)) return false;
  chrome.tabs.update(tabId, { url: blockedPage({ site }, url) }).catch(() => {});
  return true;
}

// ---- One visit to a "needed" site
// The site opens only in the tab where the intention was typed (and tabs the
// site itself opens from there). Closing the tab or leaving the site ends it.
// Stored in session storage: the worker may restart; Chrome restarting
// clears it, together with the tabs and session rules.
let visitsCache = {};
let visitLock = Promise.resolve();
// Serialized read-modify-write of the visits.
function withVisits(fn) {
  visitLock = visitLock.then(async () => {
    const visits = (await chrome.storage.session.get({ needVisits: {} })).needVisits;
    const r = await fn(visits);
    await chrome.storage.session.set({ needVisits: visits });
    visitsCache = visits;
    return r;
  });
  return visitLock;
}
chrome.storage.session.get({ needVisits: {} }).then((v) => (visitsCache = v.needVisits));

function visitOfTab(tabId, url) {
  for (const [id, v] of Object.entries(visitsCache)) {
    if (v.tabs.includes(tabId) && (!url || onHost(v.host, url))) return id;
  }
  return null;
}

async function setVisitRule(id, v) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [Number(id)],
    addRules: v.tabs.length
      ? [{
          id: Number(id),
          priority: 4,
          action: { type: "allow" },
          condition: { requestDomains: [v.host], tabIds: v.tabs, resourceTypes: ["main_frame", "sub_frame"] },
        }]
      : [],
  });
}

async function startVisit(site, tabId) {
  const { host } = splitSite(site);
  return withVisits(async (visits) => {
    // Already in a visit in this tab? Reuse it.
    for (const [id, v] of Object.entries(visits)) if (v.tabs.includes(tabId) && v.host === host) return id;
    const n = (await chrome.storage.session.get({ visitCounter: 0 })).visitCounter + 1;
    await chrome.storage.session.set({ visitCounter: n });
    const id = String(VISIT_RULE_BASE + (n % 50000));
    visits[id] = { site, host, tabs: [tabId], started: Date.now() };
    await setVisitRule(id, visits[id]);
    scheduleCheckin(id);
    return id;
  });
}

async function endVisit(visits, id, toBlockedPage = true) {
  const v = visits[id];
  if (!v) return;
  delete visits[id];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [Number(id)] });
  chrome.alarms.clear("checkin:" + id);
  if (!toBlockedPage) return;
  for (const tabId of v.tabs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && onHost(v.host, tab.url)) chrome.tabs.update(tabId, { url: blockedPage({ site: v.site }, tab.url) }).catch(() => {});
  }
}

function dropTab(tabId) {
  if (!Object.values(visitsCache).some((v) => v.tabs.includes(tabId))) return;
  withVisits(async (visits) => {
    for (const [id, v] of Object.entries(visits)) {
      if (!v.tabs.includes(tabId)) continue;
      v.tabs = v.tabs.filter((t) => t !== tabId);
      if (v.tabs.length) await setVisitRule(id, v);
      else await endVisit(visits, id, false);
    }
  });
}

chrome.tabs.onRemoved.addListener(dropTab);

// A tab the visit's site opens (a message, a post) belongs to the visit.
// webNavigation names the page that really opened it (tab "openers" follow
// the tab strip and can be wrong).
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  const id = visitOfTab(d.sourceTabId);
  if (!id) return;
  withVisits(async (visits) => {
    const v = visits[id];
    if (!v || v.tabs.includes(d.tabId)) return;
    v.tabs.push(d.tabId);
    await setVisitRule(id, v);
  }).then(async () => {
    // Its first page may have been blocked before the rule covered the tab
    // (Chrome starts loading it right away). Look a few times and open it.
    for (const ms of [0, 200, 600, 1500]) {
      await new Promise((r) => setTimeout(r, ms));
      const t = await chrome.tabs.get(d.tabId).catch(() => null);
      const v = visitsCache[id];
      if (!t || !v) return;
      const url = t.pendingUrl || t.url || "";
      const original = url.startsWith(chrome.runtime.getURL("blocker/")) ? decodeHash(url) : null;
      if (original && onHost(v.host, original)) {
        chrome.tabs.update(d.tabId, { url: original }).catch(() => {});
        return;
      }
      if (onHost(v.host, url)) return; // it loaded the site
    }
  });
});

function decodeHash(url) {
  const i = url.indexOf("#");
  return i < 0 ? null : url.slice(i + 1);
}

// Sites like YouTube change page without loading a new one (Shorts from a
// video page); Chrome's blocking doesn't see that, so the new address is
// checked here. Also: a visit ends when its tab leaves the site.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const ours = info.url.startsWith(chrome.runtime.getURL(""));
  if (!ours && Object.values(visitsCache).some((v) => v.tabs.includes(tabId) && !onHost(v.host, info.url))) {
    dropTab(tabId);
  }
  if (ours) {
    const original = decodeHash(info.url);
    if (original && visitOfTab(tabId, original)) {
      // A visit tab that was blocked before its rule applied: open it.
      chrome.tabs.update(tabId, { url: original }).catch(() => {});
    } else if (visitOfTab(tabId)) {
      dropTab(tabId); // went to some other (blocked) site: the visit is over
    }
    return;
  }
  enforceTab(tabId, info.url);
});

// ---- "Still working?" check-in during a visit
async function checkinDelay() {
  // Tests may shorten it (never lengthen).
  const t = (await chrome.storage.session.get({ testCheckinMs: 0 })).testCheckinMs;
  return t > 0 ? Math.min(t, CHECKIN_MS) : CHECKIN_MS;
}

async function scheduleCheckin(id) {
  chrome.alarms.create("checkin:" + id, { when: Date.now() + (await checkinDelay()) });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("checkin:")) return;
  const id = alarm.name.slice(8);
  const v = visitsCache[id] || (await chrome.storage.session.get({ needVisits: {} })).needVisits[id];
  if (!v) return;
  let shown = false;
  for (const tabId of v.tabs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !onHost(v.host, tab.url)) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: showCheckin, args: [id] });
      shown = true;
    } catch (e) {}
  }
  if (!shown) scheduleCheckin(id); // no tab could show it now; ask again later
});

// Runs inside the visited page.
function showCheckin(visitId) {
  if (document.getElementById("haram-blocker-checkin")) return;
  const host = document.createElement("div");
  host.id = "haram-blocker-checkin";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  root.innerHTML = `
    <style>
      .bg { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center;
            font: 16px/1.5 system-ui, sans-serif; }
      .box { background: ${dark ? "#131c1a" : "#fffdf8"}; color: ${dark ? "#e9eeec" : "#1d2422"}; max-width: 420px; margin: 16px;
             padding: 24px; border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
      h2 { margin: 0 0 8px; font-size: 20px; }
      p { margin: 0 0 18px; }
      .v { font-family: Georgia, serif; font-style: italic; }
      .row { display: flex; gap: 10px; flex-wrap: wrap; }
      button { font: inherit; border-radius: 10px; padding: 10px 18px; cursor: pointer; }
      .close { background: ${dark ? "#2dd4bf" : "#0f766e"}; color: ${dark ? "#062621" : "#fff"}; border: 0; font-weight: 600; }
      .go { background: none; color: inherit; border: 1px solid ${dark ? "#26322f" : "#dcd8cc"}; }
    </style>
    <div class="bg"><div class="box" role="dialog" aria-label="Still working?">
      <h2>Still working?</h2>
      <p>You opened this site for a need an hour ago.</p>
      <p class="v">"Is he then unaware that Allah seeth?" (Quran, Al-Alaq 96:14)</p>
      <div class="row"><button class="close">I'm done, close it</button><button class="go">Still working</button></div>
    </div></div>`;
  const answer = (choice) => {
    host.remove();
    chrome.runtime.sendMessage({ t: "needCheckin", visit: visitId, choice });
  };
  root.querySelector(".close").onclick = () => answer("close");
  root.querySelector(".go").onclick = () => answer("continue");
  (document.body || document.documentElement).appendChild(host);
}

// ---- Loosening a block: a pause and a typed sentence. The page shows the
// verses and the countdown; the rule is enforced here. Start times live in
// session storage (the worker may be stopped while the page counts down).
async function loosenStartTime(target) {
  const k = "unblockStart:" + target;
  return (await chrome.storage.session.get(k))[k];
}
function sameSentence(a, b) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[’‘]/g, "'").replace(/[.,\s]+/g, " ").trim();
  return norm(a) === norm(b);
}

async function loosen(target, sender) {
  const s = await chrome.storage.local.get(DEFAULTS);
  const sites = cleanSites(s.blockedSites);
  const needed = cleanSites(s.neededSites);
  if (target === "adult-list") {
    await chrome.storage.local.set({ blockAdult: false, slipped: true });
  } else if (target.startsWith("site:")) {
    const site = target.slice(5);
    await chrome.storage.local.set({
      blockedSites: sites.filter((x) => x !== site),
      neededSites: needed.filter((x) => x !== site),
      slipped: true,
    });
  } else if (target.startsWith("adult:")) {
    const host = normalizeSite(target.slice(6));
    if (!host) throw new Error("bad site");
    await chrome.storage.local.set({ adultAllowed: [...cleanSites(s.adultAllowed), host.split("/")[0]], slipped: true });
  } else if (target.startsWith("need-mark:")) {
    const site = target.slice(10);
    if (!sites.includes(site)) throw new Error("That site isn't in your blocked list.");
    if (!needed.includes(site)) await chrome.storage.local.set({ neededSites: [...needed, site] });
    return {};
  } else if (target.startsWith("need:")) {
    const site = target.slice(5);
    if (!sites.includes(site) || !needed.includes(site)) throw new Error("That site isn't marked as needed.");
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) throw new Error("no tab");
    await startVisit(site, tabId);
    return {}; // the page opens the site itself
  } else {
    throw new Error("unknown target");
  }
  await syncBlockRules();
  return {};
}

function blockerMessage(msg, sender, sendResponse) {
  const fail = (e) => sendResponse({ error: String((e && e.message) || e) });
  if (msg.t === "block") {
    // Adding a block (with or without "I sometimes need this site") only
    // makes things stricter, so it needs no pause.
    const site = normalizeSite(msg.site);
    if (!site) {
      sendResponse({ error: "That doesn't look like a website address." });
      return;
    }
    chrome.storage.local.get(DEFAULTS).then(async (s) => {
      const sites = cleanSites(s.blockedSites);
      const needed = cleanSites(s.neededSites);
      const isNew = !sites.includes(site);
      if (isNew) sites.push(site);
      const fix = { blockedSites: sites };
      if (isNew && msg.needed && !needed.includes(site)) fix.neededSites = [...needed, site];
      // Blocking it yourself overrides an earlier "unblock" from the adult list.
      fix.adultAllowed = cleanSites(s.adultAllowed).filter((x) => x !== splitSite(site).host);
      await chrome.storage.local.set(fix);
      await syncBlockRules();
      sendResponse({ ok: true, site, markLater: !isNew && msg.needed && !needed.includes(site) });
    }, fail);
  } else if (msg.t === "unneed") {
    // Stricter: immediate.
    chrome.storage.local.get(DEFAULTS).then(async (s) => {
      await chrome.storage.local.set({ neededSites: cleanSites(s.neededSites).filter((x) => x !== msg.site) });
      await syncBlockRules();
      sendResponse({ ok: true });
    }, fail);
  } else if (msg.t === "blockAdult") {
    chrome.storage.local.set({ blockAdult: true }).then(syncBlockRules).then(() => sendResponse({ ok: true }), fail);
  } else if (msg.t === "unblockStart") {
    const k = LOOSEN[loosenKind(msg.target)];
    chrome.storage.session
      .set({ ["unblockStart:" + msg.target]: Date.now() })
      .then(() => sendResponse({ waitMs: k.waitMs, sentence: k.sentence }), fail);
  } else if (msg.t === "unblockFinish") {
    const k = LOOSEN[loosenKind(msg.target)];
    loosenStartTime(msg.target).then(async (t0) => {
      if (!t0 || Date.now() - t0 < k.waitMs - 250) {
        sendResponse({ error: "Please wait until the countdown ends." });
      } else if (!sameSentence(msg.text, k.sentence)) {
        sendResponse({ error: "The sentence doesn't match." });
      } else {
        await chrome.storage.session.remove("unblockStart:" + msg.target);
        loosen(msg.target, sender).then(() => sendResponse({ ok: true }), fail);
      }
    }, fail);
  } else if (msg.t === "needCheckin") {
    if (msg.choice === "continue") {
      if (visitsCache[msg.visit]) scheduleCheckin(msg.visit);
      sendResponse({ ok: true });
    } else {
      withVisits((visits) => endVisit(visits, msg.visit, true)).then(() => sendResponse({ ok: true }), fail);
    }
  }
}

const BLOCKER_MESSAGES = ["block", "unneed", "blockAdult", "unblockStart", "unblockFinish", "needCheckin"];

// ---------------------------------------------------------------- popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (BLOCKER_MESSAGES.includes(msg.t)) {
    blockerMessage(msg, sender, sendResponse);
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
  for (const k of ["blockedSites", "adultAllowed", "neededSites"]) {
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
