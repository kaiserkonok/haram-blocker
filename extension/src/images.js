// Haram Blocker — image check (isolated content script).
//
// images.css hides every image before the page draws. This script sends each
// image to the GPU helper (through the background worker) and marks it
// data-hb="ok" only if no person of the hidden gender is in it. Anything that
// fails stays hidden.

(() => {
  "use strict";
  const DEFAULTS = { imageMode: "off", imageStyle: "color", imageColor: "#000000", imageBlur: 40, sites: [] };
  const MIN_SIZE = 40; // px; smaller images (icons) are shown without a check
  const MAX_SIDE = 384; // images are sent at most this big
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
  function sourceOf(el) {
    if (el instanceof HTMLImageElement) return el.currentSrc || el.src;
    return (el.href && el.href.baseVal) || el.getAttribute("href") || el.getAttribute("xlink:href");
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
    const src = sourceOf(el);
    if (!src) return;
    if (seen.get(el) === src) return;
    seen.set(el, src);
    el.removeAttribute("data-hb"); // hidden while checking

    let data = null;
    if (el instanceof HTMLImageElement) {
      // SVGs without a set size report 0 x 0 but can still be drawn.
      const svg = /\.svg([?#]|$)/i.test(src) || src.startsWith("data:image/svg");
      if (!el.complete || (!el.naturalWidth && !svg)) {
        seen.delete(el); // checked again on its load event
        return;
      }
      if (el.naturalWidth && Math.min(el.naturalWidth, el.naturalHeight) < MIN_SIZE) {
        el.setAttribute("data-hb", "ok");
        return;
      }
      if (el.naturalWidth) {
        try {
          data = snapshot(el);
        } catch (e) {
          data = null; // page won't let us read it; the background downloads it
        }
      }
    }

    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ t: "img", url: src, data });
    } catch (e) {
      r = null;
    }
    if (sourceOf(el) !== src) return; // changed meanwhile; that change is checked separately
    el.setAttribute("data-hb", r && r.hide === false ? "ok" : "hide");
    if (!r || r.retry) {
      // Helper not ready yet: stay hidden and try again shortly.
      setTimeout(() => {
        if (seen.get(el) === src) seen.delete(el);
        check(el);
      }, 3000);
    }
  }

  function isImage(n) {
    return n instanceof HTMLImageElement || (typeof SVGImageElement !== "undefined" && n instanceof SVGImageElement);
  }

  function scan(node) {
    if (!on) return;
    if (isImage(node)) check(node);
    if (node.querySelectorAll) node.querySelectorAll("img, image").forEach(check);
  }

  // New images, and images whose source changes (lazy loading, carousels).
  new MutationObserver((records) => {
    if (!on) return;
    for (const r of records) {
      if (r.type === "attributes") {
        if (isImage(r.target)) {
          seen.delete(r.target);
          r.target.removeAttribute("data-hb"); // hide the new picture at once
          check(r.target);
        }
      } else {
        for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
      }
    }
  }).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "href", "xlink:href"],
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
      const restyle = settings && (v.imageMode !== settings.imageMode);
      settings = v;
      if (restyle) {
        // Switched "I am male/female": hide everything again and re-check.
        for (const el of document.querySelectorAll("img, image")) {
          seen.delete(el);
          el.removeAttribute("data-hb");
        }
      }
      apply();
    });
  });
})();
