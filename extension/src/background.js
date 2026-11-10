// Haram Blocker — background service worker.
// Keeps the GPU helper running (Chrome starts it through native messaging)
// and passes audio between pages and the helper.

const HOST = "com.haram_blocker.cleaner";
const DEFAULTS = { sites: [], channels: [], lipSync: true };

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
  } else if (m.t === "status") {
    helper = m;
    if (m.state === "ready") retryMs = 2000;
  } else if (m.t === "pong") {
    lastPong = { ...m, at: Date.now() };
  }
}

setInterval(() => {
  if (native && helper.state === "ready") native.postMessage({ t: "ping" });
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

// ---------------------------------------------------------------- popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set(s);
});

// Start the helper as soon as Chrome starts, so the AI is warm before the
// first video.
connectHelper();
