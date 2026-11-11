// Haram Blocker — page script (runs in the page's own JavaScript world, before
// any of the page's scripts).
//
// Every sound the page can make is re-routed through a "cleaner" before it
// reaches the speakers:
//   * <video>/<audio> elements -> our AudioContext -> cleaner -> speakers
//   * the page's own Web Audio graphs: anything connected to the speakers is
//     re-routed into a cleaner on that context.
// The cleaner (worklet.js) sends audio to the GPU helper and plays back only
// the voice, delayed by DELAY_SEC. Until the helper answers, it plays silence.
//
// Videos are also shown DELAY_SEC late (a canvas drawn over the video), so
// lips stay in sync with the delayed voice.

(() => {
  "use strict";
  if (window.__haramBlockerLoaded) return;
  Object.defineProperty(window, "__haramBlockerLoaded", { value: true });

  const DELAY_SEC = 1.0;
  const CHUNK_SEC = 0.2;

  // ---- Keep references to the real browser functions before anyone patches them.
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const BaseAC = window.BaseAudioContext || AC;
  const OfflineAC = window.OfflineAudioContext;
  const Dest = window.AudioDestinationNode;
  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const origCreateMES = AC.prototype.createMediaElementSource;
  const origPlay = HTMLMediaElement.prototype.play;
  const origAttachShadow = Element.prototype.attachShadow;
  const destinationOf = Object.getOwnPropertyDescriptor(BaseAC.prototype, "destination").get;
  const MediaEl = HTMLMediaElement;
  const volumeDesc = Object.getOwnPropertyDescriptor(MediaEl.prototype, "volume");
  const mutedDesc = Object.getOwnPropertyDescriptor(MediaEl.prototype, "muted");

  const log = (...a) => console.debug("[haram-blocker]", ...a);

  // ------------------------------------------------------------------------
  // Bridge to the extension (isolated content script) via a private channel.
  // ------------------------------------------------------------------------
  const channel = new MessageChannel();
  const bridge = channel.port1;
  let portSent = false;
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__haramBlocker !== "hello" || portSent) return;
    portSent = true;
    window.postMessage({ __haramBlocker: "port" }, "*", [channel.port2]);
  });
  window.postMessage({ __haramBlocker: "main-ready" }, "*");

  let settings = null; // { sites: [], channels: [{id, name}], lipSync: bool }
  let workletUrl = null;
  let workletSource = null;
  let resolveWorklet;
  const workletInfo = new Promise((r) => (resolveWorklet = r));

  // ------------------------------------------------------------------------
  // Cleaner pipelines (one per AudioContext)
  // ------------------------------------------------------------------------
  const ourContexts = new WeakSet();
  const pipelines = new WeakMap(); // AudioContext -> Pipeline
  const pipelineById = new Map();
  let nextPipelineId = 1;

  const workletLoads = new WeakMap(); // AudioContext -> Promise
  function loadWorklet(ctx) {
    if (!workletLoads.has(ctx)) workletLoads.set(ctx, addWorklet(ctx));
    return workletLoads.get(ctx);
  }

  async function addWorklet(ctx) {
    await workletInfo;
    // A blob URL works on most sites; many (e.g. YouTube) refuse to load a
    // worklet from the extension's own URL and log an error if we try first.
    if (workletSource) {
      const blobUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
        return;
      } catch (e) {
        log("worklet via blob failed, trying extension URL", e);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }
    await ctx.audioWorklet.addModule(workletUrl);
  }

  class Pipeline {
    constructor(ctx, frozen = false) {
      this.ctx = ctx;
      this.id = nextPipelineId++;
      this.epoch = 1;
      this.node = null;
      this.frozen = frozen;
      this.bypassed = false;
      this.disposed = false;
      // Sound enters here. Until the worklet is loaded this goes nowhere,
      // i.e. silence — never the original audio.
      this.input = ctx.createGain();
      // Everything leaves through here; the element's volume/mute is applied
      // on this gain so changes are heard at once, not 1 s later.
      this.output = ctx.createGain();
      origConnect.call(this.output, destinationOf.call(ctx));
      this.owners = new Set(); // media elements whose sound ends here (page contexts)
      pipelineById.set(this.id, this);
      this.ready = this.init().catch((e) => log("cleaner failed to start; staying silent", e));
    }

    async init() {
      await loadWorklet(this.ctx);
      const sr = this.ctx.sampleRate;
      const node = new AudioWorkletNode(this.ctx, "haram-cleaner", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: { chunk: Math.round(CHUNK_SEC * sr), delay: Math.round(DELAY_SEC * sr) },
      });
      node.port.onmessage = (e) => {
        const m = e.data;
        if (m.t === "chunk") {
          m.sid = this.id;
          m.sr = sr;
          if (m.pcm) bridge.postMessage(m, [m.pcm]);
          else bridge.postMessage(m);
        } else if (m.t === "stats") {
          bridge.postMessage({ t: "stats", sid: this.id, ...m });
          if (window.__haramBlockerTest) (window.__haramBlockerStats ||= []).push({ t: performance.now(), stats: m });
        }
      };
      node.port.postMessage({ t: "flush", epoch: this.epoch });
      node.port.postMessage({ t: "freeze", on: this.frozen });
      if (this.disposed) return;
      origConnect.call(node, this.output);
      this.node = node;
      origConnect.call(this.input, this.bypassed ? this.output : node);
      if (document.documentElement.hasAttribute("data-haram-blocker-test")) this.attachTestProbe();
    }

    // Test pages only: record input/output loudness so automated tests can
    // check that music is removed and nothing leaks.
    attachTestProbe() {
      const probe = (from) => {
        const a = this.ctx.createAnalyser();
        a.fftSize = 2048;
        origConnect.call(from, a);
        return a;
      };
      const aIn = probe(this.input);
      const aOut = probe(this.output);
      const buf = new Float32Array(2048);
      const rms = (a) => {
        a.getFloatTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += v * v;
        return Math.sqrt(s / buf.length);
      };
      const log = (window.__haramBlockerTest = window.__haramBlockerTest || []);
      setInterval(() => {
        log.push({ id: this.id, t: performance.now(), ctxTime: this.ctx.currentTime, state: this.ctx.state, frozen: this.frozen, in: rms(aIn), out: rms(aOut) });
      }, 50);
    }

    deliver(m) {
      if (!this.node) return;
      if (m.pcm) this.node.port.postMessage(m, [m.pcm]);
      else this.node.port.postMessage(m);
    }

    flush() {
      this.epoch++;
      if (this.node) this.node.port.postMessage({ t: "flush", epoch: this.epoch });
    }

    // Paused: stop the whole delay line instantly (no sound comes out, nothing
    // new goes in). Resuming continues exactly where it stopped, with no wait.
    freeze(on) {
      if (on === this.frozen) return;
      this.frozen = on;
      if (this.node) this.node.port.postMessage({ t: "freeze", on });
    }

    // Allowed site/channel: sound goes straight to the speakers, no cleaning.
    setBypass(on) {
      if (on === this.bypassed) return;
      this.bypassed = on;
      this.flush();
      if (!this.node) return; // init() wires it the right way once loaded
      try {
        origDisconnect.call(this.input, on ? this.node : this.output);
      } catch (e) {}
      origConnect.call(this.input, on ? this.output : this.node);
    }

    // Volume at the very end of the chain: takes effect immediately (a 4 ms
    // ramp avoids a click).
    setGain(g) {
      const p = this.output.gain;
      if (this.gainValue === g) return;
      this.gainValue = g;
      const t = this.ctx.currentTime;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(g, t, 0.004);
    }

    dispose() {
      this.disposed = true;
      pipelineById.delete(this.id);
      try {
        origDisconnect.call(this.input);
      } catch (e) {}
      try {
        origDisconnect.call(this.output);
      } catch (e) {}
      if (this.node) {
        try {
          origDisconnect.call(this.node);
        } catch (e) {}
        this.node.port.close();
        this.node = null;
      }
    }
  }

  let pageContextCount = 0;
  function pipelineFor(ctx) {
    let p = pipelines.get(ctx);
    if (!p) {
      if (!ourContexts.has(ctx)) pageContextCount++;
      p = new Pipeline(ctx);
      pipelines.set(ctx, p);
    }
    return p;
  }

  // ------------------------------------------------------------------------
  // Page Web Audio: anything sent to the speakers goes through a cleaner.
  // ------------------------------------------------------------------------
  function isPageSpeakers(node) {
    return (
      node instanceof Dest &&
      !ourContexts.has(node.context) &&
      !(OfflineAC && node.context instanceof OfflineAC)
    );
  }

  AudioNode.prototype.connect = function (dest, ...rest) {
    if (isPageSpeakers(dest)) {
      origConnect.call(this, pipelineFor(dest.context).input, ...rest);
      return dest;
    }
    return origConnect.call(this, dest, ...rest);
  };

  AudioNode.prototype.disconnect = function (dest, ...rest) {
    if (dest && isPageSpeakers(dest)) {
      try {
        return origDisconnect.call(this, pipelineFor(dest.context).input, ...rest);
      } catch (e) {
        return undefined;
      }
    }
    return origDisconnect.apply(this, arguments);
  };

  // ------------------------------------------------------------------------
  // <video>/<audio> elements
  // ------------------------------------------------------------------------
  let mediaCtx = null;
  function getMediaCtx() {
    if (!mediaCtx) {
      mediaCtx = new AC({ latencyHint: "playback" });
      ourContexts.add(mediaCtx);
      // Once sound is allowed, muted videos can be captured too (see
      // Hook.applyVolume), so unmuting is instant.
      mediaCtx.addEventListener("statechange", () => {
        for (const h of liveHooks) h.applyVolume();
      });
    }
    return mediaCtx;
  }

  function resumeAudio() {
    if (mediaCtx && mediaCtx.state === "suspended") mediaCtx.resume().catch(() => {});
  }
  for (const ev of ["pointerdown", "keydown", "touchstart", "click"]) {
    window.addEventListener(ev, resumeAudio, { capture: true, passive: true });
  }

  const hooked = new WeakMap(); // element -> Hook
  const liveHooks = new Set();

  // Each <video>/<audio> is wired one of two ways:
  //   route "own":  element -> our AudioContext -> its own cleaner -> speakers
  //   route "page": the page took the element into its own Web Audio graph
  //                 (e.g. YouTube "Stable Volume"). We feed the page's graph
  //                 from our context, and the page's graph ends in that
  //                 context's cleaner (see the connect() patch).
  // Either way, mode "clean" cleans it and "bypass" (allowed list) doesn't,
  // and pause/seek/new-video/lip-sync act on whichever cleaner is in use.
  class Hook {
    constructor(el, src) {
      this.el = el;
      this.src = src;
      this.route = "own";
      this.mode = null; // "clean" | "bypass"
      this.waiting = false;
      this._pipe = null;
      this.pagePipe = null;
      // Volume/mute as the page set them. While "virtual", the element itself
      // plays at full volume into the cleaner and these are applied at the
      // cleaner's output, so they take effect at once.
      this.vVolume = volumeDesc.get.call(el);
      this.vMuted = mutedDesc.get.call(el);
      this.virtual = false;
      this.selfEvents = 0; // volumechange events caused by our own writes
      this.overlay = el instanceof HTMLVideoElement ? new Overlay(el) : null;
      liveHooks.add(this);

      el.addEventListener("loadstart", () => {
        // New video in this element (e.g. next reel): drop everything queued
        // from the previous one instantly, start cleaned, re-check allowed list.
        this.waiting = false;
        // YouTube Shorts reuses one <video> for every reel: drop the previous
        // reel's queued picture too, so it disappears the instant you scroll.
        if (this.overlay) this.overlay.flush();
        try {
          this.setMode("clean", true);
          this.refresh();
        } finally {
          this.updateFreeze();
        }
      });
      el.addEventListener("seeking", () => {
        if (this.mode === "clean") {
          this.active().flush();
          if (this.overlay) this.overlay.flush();
        }
      });
      el.addEventListener("play", () => {
        // Muted autoplay (Instagram/Facebook feeds) needs no sound; trying to
        // start audio then only makes Chrome log an autoplay warning.
        try {
          if (!el.muted && el.volume > 0) resumeAudio();
          this.refresh();
        } finally {
          this.updateFreeze(); // sound on/off must happen no matter what
        }
      });
      el.addEventListener("pause", () => this.updateFreeze());
      el.addEventListener("volumechange", () => {
        if (!el.muted && el.volume > 0 && !el.paused) resumeAudio();
      });
      el.addEventListener("ended", () => this.updateFreeze());
      el.addEventListener("waiting", () => {
        this.waiting = true;
        this.updateFreeze();
      });
      el.addEventListener("playing", () => {
        this.waiting = false;
        try {
          this.refresh();
        } finally {
          this.updateFreeze();
        }
      });
      for (const ev of ["loadedmetadata", "durationchange"]) {
        el.addEventListener(ev, () => this.refresh());
      }
      this.setMode("clean");
      this.refresh();
      this.updateFreeze();
      this.applyVolume();
    }

    // Our own cleaner for this element, created when needed.
    get pipe() {
      if (!this._pipe) {
        this._pipe = new Pipeline(getMediaCtx(), this.shouldFreeze());
        this._pipe.setGain(this.virtual ? this.gain() : 1);
      }
      return this._pipe;
    }

    gain() {
      return this.vMuted ? 0 : this.vVolume;
    }

    // Where this element's volume can be applied: its own cleaner, or the
    // page context's cleaner if this element is the only one feeding it.
    // null: can't apply it separately; the element's own volume is used.
    gainPipe() {
      if (this.el.hasAttribute("controls")) return null; // browser's own volume slider
      if (this.route === "own") return this.pipe;
      return this.pagePipe.owners.size === 1 ? this.pagePipe : null;
    }

    applyVolume() {
      const p = this.gainPipe();
      if (!p) {
        if (this.virtual) {
          this.virtual = false;
          if (this.route === "page") this.pagePipe.setGain(1);
          this.writeReal(this.vVolume, this.vMuted);
        }
        return;
      }
      this.virtual = true;
      p.setGain(this.gain());
      // The element plays at full volume. It stays really muted only while
      // the browser doesn't allow sound yet: unmuting it then would make
      // Chrome pause a muted autoplay video.
      const soundAllowed = mediaCtx && mediaCtx.state === "running";
      this.writeReal(1, this.vMuted && !soundAllowed);
    }

    writeReal(volume, muted) {
      const el = this.el;
      if (volumeDesc.get.call(el) !== volume) {
        this.selfEvents++;
        volumeDesc.set.call(el, volume);
      }
      if (mutedDesc.get.call(el) !== muted) {
        this.selfEvents++;
        mutedDesc.set.call(el, muted);
      }
    }

    // The page changed volume/muted (through our property setters).
    volumeChanged() {
      this.applyVolume();
      setTimeout(() => this.el.dispatchEvent(new Event("volumechange")), 0);
    }

    // A real volumechange event arrived. Ours: hide it from the page (the
    // values the page sees didn't change). Otherwise (e.g. the user changed
    // the volume some other way): adopt the new values.
    onRealVolumeChange(e) {
      if (this.selfEvents > 0) {
        this.selfEvents--;
        e.stopImmediatePropagation();
        return;
      }
      if (!this.virtual) return;
      this.vVolume = volumeDesc.get.call(this.el);
      this.vMuted = mutedDesc.get.call(this.el);
      this.applyVolume();
    }

    // The cleaner this element's sound currently goes through.
    active() {
      return this.route === "page" ? this.pagePipe : this.pipe;
    }

    // Frozen while paused or buffering. At the natural end of a video we
    // don't freeze, so the last second still plays out.
    shouldFreeze() {
      const el = this.el;
      return (el.paused && !el.ended) || this.waiting;
    }

    updateFreeze() {
      if (this.mode !== "clean") return;
      const on = this.shouldFreeze();
      this.active().freeze(on);
      if (this.overlay) this.overlay.setFrozen(on);
    }

    setMode(mode, force) {
      if (mode === this.mode && !force) return;
      const prev = this.mode;
      this.mode = mode;
      if (this.route === "own") {
        try {
          origDisconnect.call(this.src);
        } catch (e) {}
        // Allowed: the cleaner passes the sound straight through (it still
        // goes through the volume stage at the end).
        origConnect.call(this.src, this.pipe.input);
        this.pipe.setBypass(mode === "bypass"); // flushes queued audio on change
        if (mode === "clean" && force) this.pipe.flush();
      } else {
        // The element stays connected to the page's graph; the page's
        // cleaner switches between cleaning and passing through.
        this.pagePipe.setBypass(mode === "bypass");
        if (force) this.pagePipe.flush();
      }
      this.updateFreeze();
      if (this.overlay) this.overlay.setEnabled(mode === "clean" && (!settings || settings.lipSync));
    }

    refresh() {
      this.setMode(isAllowed(this.el) ? "bypass" : "clean");
    }

    // The page wants this element in its own Web Audio graph. Feed it from
    // our context (the element can only belong to one), return the node the
    // page will use, and from now on act on the page context's cleaner.
    handOffTo(pageCtx) {
      const msd = getMediaCtx().createMediaStreamDestination();
      try {
        origDisconnect.call(this.src);
      } catch (e) {}
      origConnect.call(this.src, msd);
      if (this._pipe) this._pipe.freeze(true); // our own cleaner gets no sound now
      this.route = "page";
      this.pagePipe = pipelineFor(pageCtx);
      this.pagePipe.owners.add(this);
      this.setMode(this.mode || "clean", true);
      for (const h of this.pagePipe.owners) h.applyVolume();
      return pageCtx.createMediaStreamSource(msd.stream);
    }

    // Element removed from the page (e.g. scrolled-away reel): free its cleaner.
    // It is rebuilt automatically if the element is used again.
    sleep() {
      if (this.overlay) this.overlay.setEnabled(false);
      if (this.route === "page") return; // the page's cleaner is shared; keep it
      if (!this._pipe) return;
      try {
        origDisconnect.call(this.src, this._pipe.input);
      } catch (e) {}
      this._pipe.dispose();
      this._pipe = null;
      this.mode = null;
    }
  }

  function hook(el) {
    if (!(el instanceof MediaEl)) return;
    if (hooked.has(el)) {
      const h = hooked.get(el);
      if (h && h.mode === null) {
        liveHooks.add(h);
        h.refresh();
        h.updateFreeze();
      }
      return;
    }
    let src;
    try {
      src = origCreateMES.call(getMediaCtx(), el);
    } catch (e) {
      // The page already wired this element into its own Web Audio graph;
      // that graph's output is cleaned by the connect() patch above.
      hooked.set(el, null);
      return;
    }
    hooked.set(el, new Hook(el, src));
  }

  // If the page wants the element in its own Web Audio graph (e.g. YouTube's
  // "Stable Volume"), feed that graph from our context; its output is cleaned
  // by the page context's cleaner.
  AC.prototype.createMediaElementSource = function (el) {
    const h = hooked.get(el);
    if (h && !ourContexts.has(this)) {
      try {
        return h.handOffTo(this);
      } catch (e) {
        log("hand-off failed", e);
      }
    }
    return origCreateMES.call(this, el);
  };

  HTMLMediaElement.prototype.play = function () {
    hook(this);
    return origPlay.apply(this, arguments);
  };

  // The page reads and sets the volume it chose; we apply it at the end of
  // the chain (see Hook.applyVolume). Invalid values throw like the original.
  Object.defineProperty(MediaEl.prototype, "volume", {
    configurable: true,
    enumerable: true,
    get() {
      const h = hooked.get(this);
      return h && h.virtual ? h.vVolume : volumeDesc.get.call(this);
    },
    set(v) {
      const h = hooked.get(this);
      if (!h || !h.virtual) return volumeDesc.set.call(this, v);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) return volumeDesc.set.call(this, v); // throws
      if (n === h.vVolume) return;
      h.vVolume = n;
      h.volumeChanged();
    },
  });
  Object.defineProperty(MediaEl.prototype, "muted", {
    configurable: true,
    enumerable: true,
    get() {
      const h = hooked.get(this);
      return h && h.virtual ? h.vMuted : mutedDesc.get.call(this);
    },
    set(v) {
      const h = hooked.get(this);
      if (!h || !h.virtual) return mutedDesc.set.call(this, v);
      const m = !!v;
      if (m === h.vMuted) return;
      h.vMuted = m;
      h.volumeChanged();
    },
  });

  // Runs before any page listener (capture, registered first).
  function onVolumeEvent(e) {
    if (!e.isTrusted) return;
    const h = hooked.get(e.composedPath()[0]);
    if (h) h.onRealVolumeChange(e);
  }
  window.addEventListener("volumechange", onVolumeEvent, true);

  function scan(root) {
    if (root.querySelectorAll) root.querySelectorAll("video,audio").forEach(hook);
  }

  function watch(root) {
    if (root !== document) root.addEventListener("volumechange", onVolumeEvent, true);
    for (const ev of ["loadstart", "play", "playing", "loadedmetadata", "canplay"]) {
      root.addEventListener(ev, (e) => hook(e.target), true);
    }
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n instanceof MediaEl) hook(n);
          else if (n.nodeType === 1 && n.firstElementChild) scan(n);
        }
      }
    }).observe(root, { childList: true, subtree: true });
  }
  watch(document);

  // Tests only: on request, report how each media element is wired. Answers
  // only when the page carries the test marker.
  window.addEventListener("haram-blocker-test-query", () => {
    const root = document.documentElement;
    if (!root.hasAttribute("data-haram-blocker-test")) return;
    root.setAttribute(
      "data-haram-blocker-state",
      JSON.stringify({
        pageContexts: pageContextCount,
        media: [...liveHooks].map((h) => ({
          mode: h.mode,
          frozen: h._pipe ? h._pipe.frozen : null,
          paused: h.el.paused,
          src: (h.el.currentSrc || "").slice(0, 40),
        })),
      })
    );
  });

  Element.prototype.attachShadow = function () {
    const root = origAttachShadow.apply(this, arguments);
    try {
      watch(root);
    } catch (e) {}
    return root;
  };

  // ------------------------------------------------------------------------
  // Allowed list (sites and YouTube channels)
  // ------------------------------------------------------------------------
  // Saved settings may contain bad entries (e.g. an empty channel). Never
  // let one break anything: keep only well-formed entries.
  function cleanSettings(s) {
    s = s || {};
    return {
      sites: (Array.isArray(s.sites) ? s.sites : []).filter((x) => typeof x === "string" && x),
      channels: (Array.isArray(s.channels) ? s.channels : []).filter(
        (c) => c && typeof c.id === "string" && c.id
      ),
      lipSync: s.lipSync !== false,
    };
  }

  function hostMatches(host, site) {
    return host === site || host.endsWith("." + site);
  }

  function topHost() {
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) return new URL(ao[ao.length - 1]).hostname;
    } catch (e) {}
    return location.hostname;
  }

  function siteAllowed() {
    if (!settings) return false;
    const hosts = [location.hostname, topHost()];
    return settings.sites.some((s) => hosts.some((h) => hostMatches(h, s)));
  }

  function isYouTube() {
    return /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname);
  }

  function urlVideoId() {
    const m =
      location.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/) ||
      location.search.match(/[?&]v=([\w-]{6,})/);
    return m ? m[1] : null;
  }

  // The channel of the video currently loaded in the player that owns `el`.
  // Returns null unless everything agrees (URL, player, page data) and no ad
  // is showing — when in doubt, we clean.
  function youTubeChannel(el) {
    if (!isYouTube()) return null;
    const player = el
      ? el.closest(".html5-video-player")
      : document.querySelector("#shorts-player.html5-video-player, #movie_player");
    if (!player) return null;
    if (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")) {
      return null;
    }
    try {
      const vd = player.getPlayerResponse && player.getPlayerResponse().videoDetails;
      const cur = player.getVideoData && player.getVideoData();
      const id = urlVideoId();
      if (!vd || !cur || !id || vd.videoId !== cur.video_id || vd.videoId !== id) return null;
      return { id: vd.channelId, name: vd.author };
    } catch (e) {
      return null;
    }
  }

  function isAllowed(el) {
    try {
      return isAllowedUnsafe(el);
    } catch (e) {
      log("allowed-list check failed; cleaning", e);
      return false;
    }
  }

  function isAllowedUnsafe(el) {
    if (!settings) return false;
    if (siteAllowed()) return true;
    const ch = youTubeChannel(el);
    return !!(ch && settings.channels.some((c) => c.id === ch.id));
  }

  function refreshAll() {
    for (const h of liveHooks) {
      if (!h.el.isConnected && h.el.paused) {
        h.sleep();
        liveHooks.delete(h);
        continue;
      }
      try {
        h.refresh();
        h.updateFreeze();
      } catch (e) {
        log("refresh failed", e);
      }
    }
  }
  window.addEventListener("yt-navigate-finish", refreshAll);
  window.addEventListener("yt-page-data-updated", refreshAll);
  setInterval(refreshAll, 500);

  // Ads start in the same video element: re-check the moment the player's
  // classes change so an ad never plays unfiltered.
  if (isYouTube()) {
    const watchPlayers = () => {
      document.querySelectorAll(".html5-video-player").forEach((p) => {
        if (p.__hbWatched) return;
        p.__hbWatched = true;
        new MutationObserver(refreshAll).observe(p, { attributes: true, attributeFilter: ["class"] });
      });
    };
    new MutationObserver(watchPlayers).observe(document, { childList: true, subtree: true });
  }

  // ------------------------------------------------------------------------
  // Lip sync: show the video DELAY_SEC late so it matches the delayed voice.
  // ------------------------------------------------------------------------
  class Overlay {
    constructor(video) {
      this.video = video;
      this.enabled = false;
      this.frames = []; // { at: when to show (ms), cap: when captured (ms), bmp }
      this.hasImage = false; // canvas currently holds a picture
      this.frozen = false;
      this.frozenAt = 0;
      // CSS filters other extensions put on the video (e.g. HaramBlur's blur),
      // recorded over time so the delayed picture gets the same treatment.
      this.filterHist = []; // [{ t, f }] — only changes are stored
      this.shownCap = null; // capture time of the frame on the canvas
      this.canvas = document.createElement("canvas");
      this.canvas.setAttribute("data-haram-blocker", "");
      Object.assign(this.canvas.style, {
        position: "absolute",
        pointerEvents: "none",
        display: "none",
        margin: "0",
        padding: "0",
        border: "0",
        background: "transparent",
      });
      this.g = this.canvas.getContext("2d");
    }

    setEnabled(on) {
      if (on === this.enabled) return;
      this.enabled = on;
      this.gen = (this.gen || 0) + 1; // stops loops started by an earlier enable
      if (on) {
        this.flush();
        const gen = this.gen;
        if (this.video.requestVideoFrameCallback) {
          this.video.requestVideoFrameCallback((n, m) => this.onVideoFrame(n, m, gen));
        }
        requestAnimationFrame((t) => this.render(t, gen));
      } else {
        this.clearFrames();
        this.canvas.style.display = "none";
      }
    }

    // Paused: the picture stops instantly. On resume, the frames still waiting
    // in the 1 s line continue from where they stopped (shifted in time).
    setFrozen(on) {
      if (on === this.frozen) return;
      const now = performance.now();
      if (on) {
        this.frozenAt = now;
      } else {
        const delta = now - this.frozenAt;
        for (const f of this.frames) if (f.cap <= this.frozenAt) f.at += delta;
      }
      this.frozen = on;
    }

    clearFrames() {
      for (const f of this.frames) f.bmp.close();
      this.frames = [];
    }

    flush() {
      this.clearFrames();
      this.hasImage = false;
    }

    onVideoFrame(now, meta, gen) {
      if (!this.enabled || gen !== this.gen) return;
      this.video.requestVideoFrameCallback((n, m) => this.onVideoFrame(n, m, gen));
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (!w || !h) return;
      const cap = meta.expectedDisplayTime || now;
      const at = cap + DELAY_SEC * 1000;
      const box = this.fitRect();
      createImageBitmap(this.video, {
        resizeWidth: Math.max(1, Math.round(box.w)),
        resizeHeight: Math.max(1, Math.round(box.h)),
        resizeQuality: "medium",
      })
        .then((bmp) => {
          if (!this.enabled) return bmp.close();
          this.frames.push({ at, cap, bmp });
          while (this.frames.length > 240) this.frames.shift().bmp.close();
        })
        .catch(() => {});
    }

    // Where the picture sits inside the element (object-fit), in canvas pixels.
    fitRect() {
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      const vw = this.video.videoWidth || cw;
      const vh = this.video.videoHeight || ch;
      const fit = getComputedStyle(this.video).objectFit;
      if (fit === "fill") return { x: 0, y: 0, w: cw, h: ch };
      const s = fit === "cover" ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh);
      const w = vw * s;
      const h = vh * s;
      return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    }

    place() {
      const v = this.video;
      const c = this.canvas;
      if (!v.isConnected) return false;
      if (c.parentNode !== v.parentNode || c.previousSibling !== v) v.after(c);
      const vr = v.getBoundingClientRect();
      if (!vr.width || !vr.height) return false;
      const parent = c.offsetParent || document.body;
      const pr = parent.getBoundingClientRect();
      c.style.left = vr.left - pr.left - parent.clientLeft + parent.scrollLeft + "px";
      c.style.top = vr.top - pr.top - parent.clientTop + parent.scrollTop + "px";
      c.style.width = vr.width + "px";
      c.style.height = vr.height + "px";
      const z = getComputedStyle(v).zIndex;
      c.style.zIndex = z === "auto" ? "" : z;
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(vr.width * dpr);
      const ph = Math.round(vr.height * dpr);
      if (c.width !== pw || c.height !== ph) {
        c.width = pw;
        c.height = ph;
        this.hasImage = false;
      }
      return true;
    }

    render(now, gen) {
      if (!this.enabled || gen !== this.gen) return;
      requestAnimationFrame((t) => this.render(t, gen));
      if (!this.place()) {
        this.canvas.style.display = "none";
        return;
      }
      this.recordFilter(now);
      const show = (bmp, cap) => {
        this.shownCap = cap;
        const box = this.fitRect();
        this.g.fillStyle = "#000";
        this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
        if (bmp) this.g.drawImage(bmp, box.x, box.y, box.w, box.h);
        this.canvas.style.display = "block";
      };
      const frames = this.frames;

      if (this.frozen) {
        // Paused: hold the current picture. If there is none yet (paused
        // right after a seek), show the newest captured frame as a still.
        if (!this.hasImage && frames.length) {
          const f = frames[frames.length - 1];
          show(f.bmp, f.cap);
          this.hasImage = true;
        }
        if (!this.hasImage) this.canvas.style.display = "none";
        this.applyFilter(now);
        return;
      }

      let due = null;
      while (frames.length && frames[0].at <= now) {
        if (due) due.bmp.close();
        due = frames.shift();
      }
      if (due) {
        show(due.bmp, due.cap);
        due.bmp.close();
        this.hasImage = true;
      } else if (!this.hasImage && frames.length) {
        // New video / next reel: show its first frame instantly as a still
        // while the voice is being cleaned; it starts moving when ready.
        show(frames[0].bmp, frames[0].cap);
        this.hasImage = true;
      } else if (!this.hasImage) {
        // Nothing captured yet (first few ms of a new video): let the page's
        // own picture show instead of a black flash. Sound is silent anyway.
        this.canvas.style.display = "none";
      }
      this.applyFilter(now);
    }

    recordFilter(now) {
      const f = getComputedStyle(this.video).filter || "none";
      const h = this.filterHist;
      if (!h.length || h[h.length - 1].f !== f) h.push({ t: now, f });
      // Keep 10 s of history (plus the state just before it).
      while (h.length > 1 && h[1].t < now - 10000) h.shift();
    }

    // The frame on the canvas was captured at `shownCap`, up to 1 s ago. If
    // the page's own video was filtered (blurred) at any moment between that
    // capture and now, filter the canvas too. This way a blur extension that
    // reacts late still hides the picture before it is shown.
    applyFilter(now) {
      const c = this.canvas;
      let f = "none";
      if (this.shownCap !== null) {
        const from = this.shownCap - 150;
        for (const e of this.filterHist) {
          if (e.t <= from) f = e.f; // state when the frame was captured
          else if (e.t <= now && e.f !== "none") f = e.f; // blurred later
        }
        // A later "none" must not undo a blur seen inside the window.
        const last = this.filterHist[this.filterHist.length - 1];
        if (last && last.f !== "none") f = last.f;
      }
      if (c.style.filter !== (f === "none" ? "" : f)) c.style.filter = f === "none" ? "" : f;
    }
  }

  // ------------------------------------------------------------------------
  // Messages from the extension
  // ------------------------------------------------------------------------
  bridge.onmessage = (e) => {
    const m = e.data;
    if (m.t === "out") {
      const p = pipelineById.get(m.sid);
      if (p) p.deliver(m);
    } else if (m.t === "config") {
      const first = !workletUrl;
      settings = cleanSettings(m.settings);
      if (first) {
        workletUrl = m.workletUrl;
        workletSource = m.workletSource;
        resolveWorklet();
      }
      refreshAll();
    } else if (m.t === "query") {
      const ch = youTubeChannel(null);
      bridge.postMessage({ t: "pageInfo", qid: m.qid, host: location.hostname, channel: ch });
    }
  };
})();
