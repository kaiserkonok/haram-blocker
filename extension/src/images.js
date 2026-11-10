// Haram Blocker — image check (isolated content script).
//
// images.css hides every image before the page draws. This script sends each
// image to the GPU helper (through the background worker) and marks it
// data-hb="ok" only if no person of the hidden gender is in it. Anything that
// fails stays hidden.
//
// "Image" means <img>, SVG <image>, and any element whose own style sets a
// background picture (style="background-image:url(...)"), which is how
// X/Twitter and many other sites show photos.

(() => {
  "use strict";
  const DEFAULTS = { imageMode: "off", imageLevel: "strict", imageStyle: "color", imageColor: "#000000", imageBlur: 40, sites: [] };
  const MIN_SIZE = 40; // px; smaller images (icons) are shown without a check
  const MAX_SIDE = 512; // images are sent at most this big (helper: vision.MAX_SIDE)
  const root = document.documentElement;
  if (!root) return;

  let settings = null;
  let on = false;
  const seen = new WeakMap(); // element -> source it was last checked for

  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------- settings
  function topHost() {
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) return new URL(ao[ao.length - 1]).hostname;
    } catch (e) {}
    return location.hostname;
  }

  function siteAllowed(sites) {
    const hosts = [location.hostname, topHost()];
    return sites.some((s) => hosts.some((h) => h === s || h.endsWith("." + s)));
  }

  function apply() {
    on = settings.imageMode !== "off" && !siteAllowed(settings.sites);
    if (!on) {
      root.setAttribute("data-hb-images", "off");
      return;
    }
    ensureCss();
    root.removeAttribute("data-hb-images");
    root.setAttribute("data-hb-style", settings.imageStyle === "blur" ? "blur" : "color");
    root.style.setProperty("--hb-color", settings.imageColor);
    root.style.setProperty("--hb-blur", settings.imageBlur + "px");
    scan(document);
  }

  // Tabs opened before the feature was switched on don't have images.css yet.
  function ensureCss() {
    if (getComputedStyle(root).getPropertyValue("--hb-css").trim()) return;
    if (document.getElementById("haram-blocker-images-css")) return;
    const link = document.createElement("link");
    link.id = "haram-blocker-images-css";
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("src/images.css");
    (document.head || root).appendChild(link);
  }

  // Pages sometimes rewrite <html>'s attributes; put ours back.
  new MutationObserver(() => {
    if (!settings) return;
    const want = on ? null : "off";
    if (root.getAttribute("data-hb-images") !== want) apply();
  }).observe(root, { attributes: true, attributeFilter: ["data-hb-images", "data-hb-style"] });

  // ---------------------------------------------------------------- checking
  const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

  // The pictures in an element's own background (inline style), as full URLs.
  function bgUrls(el) {
    const v = el.style && el.style.backgroundImage;
    if (!v || v === "none") return [];
    const out = [];
    for (const m of v.matchAll(URL_RE)) {
      try {
        out.push(new URL(m[2], document.baseURI).href);
      } catch (e) {}
    }
    return out;
  }

  function hasBgStyle(n) {
    return n.nodeType === 1 && !isImage(n) && /url\(/i.test(n.getAttribute("style") || "");
  }

  function sourcesOf(el) {
    if (el instanceof HTMLImageElement) return [el.currentSrc || el.src].filter(Boolean);
    if (isImage(el)) return [(el.href && el.href.baseVal) || el.getAttribute("href") || el.getAttribute("xlink:href")].filter(Boolean);
    return bgUrls(el);
  }

  function sourceOf(el) {
    return sourcesOf(el).join("\n");
  }

  const isSvgSrc = (src) => /\.svg([?#]|$)/i.test(src) || src.startsWith("data:image/svg");

  // Load a background picture ourselves to learn its size (and its pixels,
  // when the page lets us read them). null if it can't be loaded.
  async function loadPicture(src) {
    const im = new Image();
    im.src = src;
    try {
      await im.decode();
    } catch (e) {
      return null;
    }
    return im;
  }

  // What to send for one picture: {small: true} for icons, else {data}
  // (data null: the background downloads it itself).
  function describe(img, src) {
    if (img && img.naturalWidth && Math.min(img.naturalWidth, img.naturalHeight) < MIN_SIZE) return { small: true };
    let data = null;
    if (img && img.naturalWidth) {
      try {
        data = snapshot(img);
      } catch (e) {
        data = null; // page won't let us read it; the background downloads it
      }
    }
    return { data };
  }

  async function ask(src, data) {
    try {
      return await chrome.runtime.sendMessage({ t: "img", url: src, data });
    } catch (e) {
      return null;
    }
  }

  // A small JPEG of the image, if the page lets us read its pixels (same
  // origin or CORS). Otherwise null, and the background fetches it.
  function snapshot(img) {
    const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; // transparent parts on white, not black
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1]; // throws if tainted
  }

  async function check(el) {
    if (!on || !alive()) return;
    const srcs = sourcesOf(el);
    const key = srcs.join("\n");
    if (!srcs.length) {
      // A style with url() that isn't a background picture (e.g. a mask):
      // nothing to check, don't leave the box covered.
      if (hasBgStyle(el)) el.setAttribute("data-hb", "ok");
      return;
    }
    if (seen.get(el) === key) return;
    seen.set(el, key);
    el.removeAttribute("data-hb"); // hidden while checking

    const parts = [];
    if (el instanceof HTMLImageElement) {
      const src = srcs[0];
      // SVGs without a set size report 0 x 0 but can still be drawn.
      if (!el.complete || (!el.naturalWidth && !isSvgSrc(src))) {
        seen.delete(el); // checked again on its load event
        return;
      }
      parts.push({ src, ...describe(el, src) });
    } else if (isImage(el)) {
      parts.push({ src: srcs[0], data: null });
    } else {
      for (const src of srcs) parts.push({ src, ...describe(await loadPicture(src), src) });
    }

    // Shown only if every picture in it is fine.
    const answers = await Promise.all(parts.map((p) => (p.small ? { hide: false } : ask(p.src, p.data))));
    if (sourceOf(el) !== key) return; // changed meanwhile; that change is checked separately
    el.setAttribute("data-hb", answers.every((r) => r && r.hide === false) ? "ok" : "hide");
    if (answers.some((r) => !r || r.retry)) {
      // Helper not ready yet: stay hidden and try again shortly.
      setTimeout(() => {
        if (seen.get(el) === key) seen.delete(el);
        check(el);
      }, 3000);
    }
  }

  function isImage(n) {
    return n instanceof HTMLImageElement || (typeof SVGImageElement !== "undefined" && n instanceof SVGImageElement);
  }

  const SELECTOR = "img, image, [style*='url(' i]";

  function scan(node) {
    if (!on) return;
    if (isImage(node) || hasBgStyle(node)) check(node);
    if (node.querySelectorAll) node.querySelectorAll(SELECTOR).forEach(check);
  }

  // New images, and images whose source changes (lazy loading, carousels).
  new MutationObserver((records) => {
    if (!on) return;
    for (const r of records) {
      if (r.type === "attributes") {
        const el = r.target;
        if (isImage(el)) {
          if (r.attributeName === "style") continue;
          seen.delete(el);
          el.removeAttribute("data-hb"); // hide the new picture at once
          check(el);
        } else if (r.attributeName === "style" && (seen.has(el) || hasBgStyle(el))) {
          // Styles change all the time (animations); only a new background
          // picture needs a new check.
          if (seen.get(el) === sourceOf(el)) continue;
          seen.delete(el);
          el.removeAttribute("data-hb"); // hide the new picture at once
          check(el);
        }
      } else {
        for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
      }
    }
  }).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "href", "xlink:href", "style"],
  });

  // An image finished loading (or picked another size from srcset).
  document.addEventListener(
    "load",
    (e) => {
      const el = e.target;
      if (!on || !isImage(el)) return;
      if (seen.get(el) !== sourceOf(el)) el.removeAttribute("data-hb");
      check(el);
    },
    true
  );

  // ---------------------------------------------------------------- start
  chrome.storage.local.get(DEFAULTS).then((v) => {
    settings = v;
    apply();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !alive()) return;
    chrome.storage.local.get(DEFAULTS).then((v) => {
      const restyle = settings && (v.imageMode !== settings.imageMode || v.imageLevel !== settings.imageLevel);
      settings = v;
      if (restyle) {
        // Switched "I am male/female" or strictness: hide everything again and re-check.
        for (const el of document.querySelectorAll(SELECTOR)) {
          seen.delete(el);
          el.removeAttribute("data-hb");
        }
      }
      apply();
    });
  });
})();
