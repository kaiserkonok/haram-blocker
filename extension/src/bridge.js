// Haram Blocker — bridge (isolated content script).
// Connects the page script (inject.js) with the background service worker,
// which talks to the GPU helper. Also passes settings to the page script.

(() => {
  "use strict";
  const WORKLET_URL = chrome.runtime.getURL("src/worklet.js");
  let main = null; // MessagePort to inject.js
  let bg = null; // runtime Port to the background worker
  let workletSource = null;
  const queries = new Map();
  let nextQid = 1;

  // After the extension is reloaded or updated, scripts left in tabs that
  // were already open lose their connection to it. Stop quietly instead of
  // throwing "Extension context invalidated" (the page stays silent until it
  // is refreshed, which loads the new version).
  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // ---- Handshake with the page script (either one may load first).
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || main) return;
    const kind = e.data.__haramBlocker;
    if (kind === "main-ready") window.postMessage({ __haramBlocker: "hello" }, "*");
    else if (kind === "port" && e.ports[0]) {
      main = e.ports[0];
      main.onmessage = fromMain;
      sendConfig();
    }
  });
  window.postMessage({ __haramBlocker: "hello" }, "*");

  // ---- Settings
  const DEFAULTS = { sites: [], channels: [], lipSync: true };
  async function sendConfig() {
    if (!main || !alive()) return;
    try {
      await sendConfigUnsafe();
    } catch (e) {
      // extension went away mid-way; nothing to do
    }
  }

  async function sendConfigUnsafe() {
    if (workletSource === null) {
      try {
        workletSource = await (await fetch(WORKLET_URL)).text();
      } catch (e) {
        workletSource = "";
      }
    }
    const stored = await chrome.storage.local.get(DEFAULTS);
    main.postMessage({
      t: "config",
      settings: { sites: stored.sites, channels: stored.channels, lipSync: stored.lipSync },
      workletUrl: WORKLET_URL,
      workletSource,
    });
  }
  chrome.storage.onChanged.addListener((_, area) => area === "local" && sendConfig());

  // ---- base64 helpers for 16-bit PCM
  function toB64(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.toBase64) return u8.toBase64();
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64).buffer;
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8.buffer;
  }

  // ---- Background connection (made lazily, re-made if the worker restarts)
  function background() {
    if (bg) return bg;
    if (!alive()) throw new Error("extension reloaded");
    bg = chrome.runtime.connect({ name: "page" });
    bg.onMessage.addListener((m) => {
      if (m.t === "out" && main) {
        if (m.pcm) {
          const buf = fromB64(m.pcm);
          main.postMessage({ ...m, pcm: buf }, [buf]);
        } else {
          main.postMessage(m);
        }
      }
    });
    bg.onDisconnect.addListener(() => {
      bg = null;
    });
    return bg;
  }

  function fromMain(e) {
    const m = e.data;
    try {
      if (m.t === "chunk") {
        if (m.pcm) m.pcm = toB64(m.pcm);
        background().postMessage(m);
      } else if (m.t === "stats") {
        background().postMessage(m);
      } else if (m.t === "pageInfo") {
        const resolve = queries.get(m.qid);
        queries.delete(m.qid);
        if (resolve) resolve({ host: m.host, channel: m.channel });
      }
    } catch (err) {
      bg = null; // worker went away; next message reconnects
    }
  }

  // ---- Popup asks: which site / YouTube channel is this tab showing?
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.t !== "pageInfo" || window !== window.top) return;
    if (!main) {
      sendResponse({ host: location.hostname, channel: null });
      return;
    }
    const qid = nextQid++;
    queries.set(qid, sendResponse);
    main.postMessage({ t: "query", qid });
    setTimeout(() => {
      if (queries.delete(qid)) sendResponse({ host: location.hostname, channel: null });
    }, 1000);
    return true;
  });
})();
