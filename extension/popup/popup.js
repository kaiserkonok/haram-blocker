const DEFAULTS = {
  sites: [],
  channels: [],
  lipSync: true,
  imageMode: "off",
  imageLevel: "strict",
  imageStyle: "color",
  imageColor: "#000000",
  imageBlur: 40,
  blockedSites: [],
  blockAdult: true,
};
const $ = (id) => document.getElementById(id);
let tab = null;
let info = { host: "", channel: null };

async function settings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  s.sites = (s.sites || []).filter((x) => typeof x === "string" && x);
  s.channels = (s.channels || []).filter((c) => c && typeof c.id === "string" && c.id);
  return s;
}

function siteOf(host) {
  return host.replace(/^www\./, "");
}

async function render() {
  const s = await settings();
  const site = siteOf(info.host || "");

  $("host").textContent = site || "(no website)";
  const siteOn = s.sites.includes(site);
  $("toggleSite").textContent = siteOn ? "Stop allowing" : "Allow this site";
  $("toggleSite").disabled = !site;

  $("channelRow").hidden = !info.channel;
  if (info.channel) {
    const chOn = s.channels.some((c) => c.id === info.channel.id);
    $("channelName").textContent = "Channel: " + info.channel.name;
    $("toggleChannel").textContent = chOn ? "Stop allowing" : "Allow channel";
  }

  $("lipSync").checked = s.lipSync;
  $("imageMode").value = s.imageMode;
  $("imageStyleRow").hidden = s.imageMode === "off";
  for (const r of document.querySelectorAll('input[name="imageStyle"]')) r.checked = r.value === s.imageStyle;
  $("imageColor").value = s.imageColor;
  $("imageLevel").value = s.imageLevel === "balanced" ? "balanced" : "strict";
  $("imageBlur").value = s.imageBlur;

  const list = (el, items, label, remove) => {
    el.innerHTML = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "None";
      el.append(li);
    }
    for (const item of items) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = label(item);
      const b = document.createElement("button");
      b.textContent = "Remove";
      b.onclick = () => remove(item);
      li.append(span, b);
      el.append(li);
    }
  };
  renderBlocker(s);
  list($("sites"), s.sites, (x) => x, async (x) => {
    const cur = await settings();
    await chrome.storage.local.set({ sites: cur.sites.filter((y) => y !== x) });
    render();
  });
  list($("channels"), s.channels, (c) => c.name, async (c) => {
    const cur = await settings();
    await chrome.storage.local.set({ channels: cur.channels.filter((y) => y.id !== c.id) });
    render();
  });
}

// ---------------------------------------------------------------- blocker
function openUnblock(target) {
  chrome.tabs.create({ url: chrome.runtime.getURL("blocker/blocked.html") + "?" + new URLSearchParams({ unblock: target }) });
  window.close();
}

// The site you're on, and (if you're inside a section like /shorts) that section.
function blockChoices() {
  let u;
  try {
    u = new URL(tab.url);
  } catch (e) {
    return [];
  }
  if (!/^https?:$/.test(u.protocol)) return [];
  const host = u.hostname.replace(/^www\./, "");
  const out = [host];
  const first = u.pathname.split("/").filter(Boolean)[0];
  if (first) out.push(host + "/" + first.toLowerCase());
  return out;
}

async function block(site) {
  const r = await chrome.runtime.sendMessage({ t: "block", site });
  $("blockError").hidden = !r.error;
  $("blockError").textContent = r.error || "";
  if (r.ok) $("blockInput").value = "";
  render();
}

function renderBlocker(s) {
  $("blockAdult").checked = s.blockAdult;
  const here = $("blockHere");
  here.innerHTML = "";
  for (const site of blockChoices()) {
    if (s.blockedSites.includes(site)) continue;
    const b = document.createElement("button");
    b.textContent = "Block " + site;
    b.onclick = () => block(site);
    here.append(b);
  }
  const ul = $("blockedList");
  ul.innerHTML = "";
  if (!s.blockedSites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites of your own yet";
    ul.append(li);
  }
  for (const site of s.blockedSites) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "mono";
    span.textContent = site;
    const b = document.createElement("button");
    b.textContent = "Unblock";
    b.onclick = () => openUnblock("site:" + site);
    li.append(span, b);
    ul.append(li);
  }
}

$("blockForm").onsubmit = (e) => {
  e.preventDefault();
  if ($("blockInput").value.trim()) block($("blockInput").value);
};
$("blockAdult").onchange = (e) => {
  if (e.target.checked) {
    chrome.runtime.sendMessage({ t: "blockAdult" }).then(render);
  } else {
    e.target.checked = true; // turning it off goes through the same pause
    openUnblock("adult-list");
  }
};
fetch(chrome.runtime.getURL("rules/adult-count.json"))
  .then((r) => r.json())
  .then((c) => ($("adultCount").textContent = `(${c.sites.toLocaleString("en-US")})`))
  .catch(() => {});

$("toggleSite").onclick = async () => {
  const s = await settings();
  const site = siteOf(info.host || "");
  if (!site) return;
  const sites = s.sites.includes(site) ? s.sites.filter((x) => x !== site) : [...s.sites, site];
  await chrome.storage.local.set({ sites });
  render();
};

$("toggleChannel").onclick = async () => {
  const s = await settings();
  const ch = info.channel;
  if (!ch || !ch.id) return; // nothing valid to add
  const on = s.channels.some((c) => c.id === ch.id);
  const channels = on ? s.channels.filter((c) => c.id !== ch.id) : [...s.channels, ch];
  await chrome.storage.local.set({ channels });
  render();
};

$("lipSync").onchange = (e) => chrome.storage.local.set({ lipSync: e.target.checked });
$("imageMode").onchange = async (e) => {
  await chrome.storage.local.set({ imageMode: e.target.value });
  render();
};
for (const r of document.querySelectorAll('input[name="imageStyle"]')) {
  r.onchange = () => chrome.storage.local.set({ imageStyle: r.value });
}
$("imageLevel").onchange = (e) => chrome.storage.local.set({ imageLevel: e.target.value });
$("imageColor").onchange = (e) => chrome.storage.local.set({ imageColor: e.target.value, imageStyle: "color" }).then(render);
$("imageBlur").onchange = (e) => chrome.storage.local.set({ imageBlur: Number(e.target.value), imageStyle: "blur" }).then(render);

async function refreshStatus() {
  const r = await chrome.runtime.sendMessage({ t: "getStatus", tabId: tab && tab.id });
  const h = r.helper;
  const dot = $("dot");
  dot.className = "dot";
  let text, detail = "";
  if (h.state === "ready") {
    dot.classList.add("ok");
    text = "Cleaning is on";
    detail = `AI running on ${h.gpu}`;
    if (r.lastPong && r.lastPong.chunks) detail += ` · GPU busy ${Math.round(r.lastPong.gpu_busy * 100)}%`;
  } else if (h.state === "starting" || h.state === "loading") {
    dot.classList.add("warn");
    text = "Starting the AI… (sound stays off)";
  } else {
    dot.classList.add("bad");
    text = "Helper not running (sound stays off)";
    detail = h.error && /not found/i.test(h.error)
      ? "The helper program isn't installed. Run install.sh."
      : h.error || "";
  }
  const st = r.tabStats.find((x) => x.played + x.missing > 0);
  if (st && h.state === "ready" && st.late > 0) detail += " · some audio arrived late";
  $("helperText").textContent = text;
  $("helperDetail").textContent = detail;
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    info = await chrome.tabs.sendMessage(tab.id, { t: "pageInfo" }, { frameId: 0 });
  } catch (e) {
    try { info = { host: new URL(tab.url).hostname, channel: null }; } catch (e2) {}
  }
  info = info || { host: "", channel: null };
  render();
  refreshStatus();
  setInterval(refreshStatus, 1000);
})();
