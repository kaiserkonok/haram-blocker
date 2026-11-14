// Haram Blocker — the page shown instead of a blocked site.
//
// Address forms:
//   blocked.html?site=example.com#<original address>   the user's own block
//   blocked.html?list=adult#<original address>         the built-in adult list
//   blocked.html?unblock=site:example.com             unblock from the menu
//   blocked.html?unblock=adult-list                    turn the adult list off
//
// The wait and the typed sentence are enforced by the background worker;
// this page only shows them.

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const original = location.hash.slice(1);

  // Inside a frame on another site (e.g. an embedded video): a quiet notice,
  // no sound.
  if (window.top !== window) {
    $("frameNotice").hidden = false;
    return;
  }
  $("page").hidden = false;

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  };

  // What is blocked, and what unblocking it would mean.
  let label, target;
  if (params.has("unblock")) {
    target = params.get("unblock");
    label = target === "adult-list" ? "The built-in adult-site list" : target.replace(/^(site|adult):/, "");
  } else if (params.get("list") === "adult") {
    label = hostOf(original);
    target = "adult:" + label;
  } else {
    label = params.get("site") || hostOf(original);
    target = "site:" + label;
  }

  // ------------------------------------------------------------ verses
  let verses = null;
  const versesReady = fetch("verses.json").then((r) => r.json()).then((d) => (verses = d.passages));

  const arabicNumber = (n) => n.toLocaleString("ar-EG");

  let player = null; // the recitation currently playing
  function stopRecitation() {
    if (player) player.stop();
    player = null;
  }

  // Plays the passage's ayat one after another.
  function recite(passage, button) {
    stopRecitation();
    const files = passage.ayat.map((a) => "audio/" + a.audio);
    let i = 0;
    let audio = null;
    let stopped = false;
    const setPlaying = (on) => {
      button.textContent = on ? "■ Stop" : "▶ Listen";
      button.classList.remove("nudge");
    };
    const next = () => {
      if (stopped || i >= files.length) {
        setPlaying(false);
        if (player === me) player = null;
        return Promise.resolve();
      }
      audio = new Audio(files[i++]);
      audio.onended = next;
      audio.onerror = () => {
        button.hidden = true; // recitation not installed
        setPlaying(false);
      };
      return audio.play();
    };
    const me = {
      stop() {
        stopped = true;
        if (audio) audio.pause();
        setPlaying(false);
      },
    };
    player = me;
    setPlaying(true);
    return next().catch((e) => {
      // Chrome didn't allow sound to start by itself: invite a click.
      player = null;
      setPlaying(false);
      if (e && e.name === "NotAllowedError") button.classList.add("nudge");
    });
  }

  function showVerse(figure, passage, autoplay) {
    figure.textContent = "";
    const ar = document.createElement("p");
    ar.className = "ar";
    ar.lang = "ar";
    ar.dir = "rtl";
    for (const a of passage.ayat) {
      ar.append(a.ar + " ");
      const n = document.createElement("span");
      n.className = "num";
      n.textContent = "﴿" + arabicNumber(a.a) + "﴾";
      ar.append(n, " ");
    }
    const en = document.createElement("p");
    en.className = "en";
    en.textContent = passage.ayat.map((a) => a.en).join(" ");
    const cap = document.createElement("figcaption");
    const ref = document.createElement("span");
    ref.textContent = "Quran, " + passage.ref;
    const play = document.createElement("button");
    play.className = "play";
    play.type = "button";
    play.textContent = "▶ Listen";
    play.onclick = () => (player ? stopRecitation() : recite(passage, play));
    cap.append(ref, play);
    figure.append(ar, en, cap);
    figure.dataset.ref = passage.ref;
    if (autoplay) recite(passage, play);
  }

  // A different passage each time, in turn, so they don't become wallpaper.
  async function pick(where, extra = []) {
    await versesReady;
    const pool = verses.filter((p) => p.where === where || extra.includes(p.where));
    const key = "verseTurn:" + where;
    const turn = (await chrome.storage.local.get({ [key]: 0 }))[key];
    await chrome.storage.local.set({ [key]: turn + 1 });
    return pool[turn % pool.length];
  }

  // ------------------------------------------------------------ views
  function show(id) {
    for (const s of ["blocked", "unblockPanel", "done"]) $(s).hidden = s !== id;
    window.scrollTo(0, 0);
  }

  async function showBlocked() {
    show("blocked");
    document.title = "Blocked: " + label;
    $("site").textContent = label;
    const s = await chrome.storage.local.get({ slipped: false, imageMode: "off" });
    let passage;
    if (s.slipped) {
      // Came back after unblocking something: hope first, not blame.
      await versesReady;
      passage = verses.find((p) => p.where === "mercy");
      $("mercy").hidden = false;
      await chrome.storage.local.set({ slipped: false });
    } else {
      passage = await pick("blocked", s.imageMode === "male" ? ["men"] : []);
    }
    showVerse($("verse"), passage, true);
  }

  let countdown = null;
  async function showUnblock() {
    stopRecitation();
    show("unblockPanel");
    document.title = "Unblock: " + label;
    $("unblockWhat").textContent = label;
    $("typeStep").hidden = true;
    $("waitLine").hidden = false;
    $("sentence").value = "";
    $("confirm").disabled = true;
    $("error").hidden = true;

    const r = await chrome.runtime.sendMessage({ t: "unblockStart", target });
    showVerse($("unblockVerse"), await pick("unblock"), true);
    $("sentenceText").textContent = r.sentence;
    const end = Date.now() + r.waitMs;
    clearInterval(countdown);
    const tick = () => {
      const left = Math.ceil((end - Date.now()) / 1000);
      $("count").textContent = Math.max(0, left);
      if (left <= 0) {
        clearInterval(countdown);
        $("waitLine").hidden = true;
        $("typeStep").hidden = false;
        $("sentence").focus();
      }
    };
    tick();
    countdown = setInterval(tick, 250);
  }

  const norm = (x) => x.toLowerCase().replace(/[’‘]/g, "'").replace(/[.\s]+/g, " ").trim();
  $("sentence").addEventListener("input", () => {
    $("confirm").disabled = norm($("sentence").value) !== norm($("sentenceText").textContent);
  });
  // Typing it is the point; pasting it isn't.
  for (const ev of ["paste", "drop"]) $("sentence").addEventListener(ev, (e) => e.preventDefault());

  $("confirm").onclick = async () => {
    $("confirm").disabled = true;
    const r = await chrome.runtime.sendMessage({ t: "unblockFinish", target, text: $("sentence").value });
    if (!r || !r.ok) {
      $("error").textContent = (r && r.error) || "Couldn't unblock.";
      $("error").hidden = false;
      $("confirm").disabled = false;
      return;
    }
    stopRecitation();
    if (original) {
      location.replace(original);
    } else {
      show("done");
      $("doneWhat").textContent = label;
    }
  };

  $("keep").onclick = () => {
    clearInterval(countdown);
    if (params.has("unblock")) closeTab();
    else showBlocked();
  };

  $("unblock").onclick = showUnblock;

  // Go back to where you were. For a blocked part of a site (e.g. Shorts),
  // the previous page may be that same part, so go to the site's home.
  $("back").onclick = () => {
    stopRecitation();
    const isPath = !params.has("list") && (params.get("site") || "").includes("/");
    if (isPath && original) {
      try {
        location.replace(new URL(original).origin + "/");
        return;
      } catch (e) {}
    }
    if (history.length > 1) {
      history.back();
      setTimeout(newTab, 400); // nothing to go back to
    } else {
      newTab();
    }
  };

  async function newTab() {
    const t = await chrome.tabs.getCurrent();
    if (t) chrome.tabs.update(t.id, { url: "chrome://newtab/" });
  }
  async function closeTab() {
    const t = await chrome.tabs.getCurrent();
    if (t) chrome.tabs.remove(t.id);
  }
  $("close").onclick = closeTab;

  if (params.has("unblock")) showUnblock();
  else showBlocked();
})();
