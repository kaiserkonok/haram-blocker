const DEFAULTS = { sites: [], channels: [], lipSync: true };
const $ = (id) => document.getElementById(id);
let tab = null;
let info = { host: "", channel: null };

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
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

$("toggleSite").onclick = async () => {
  const s = await settings();
  const site = siteOf(info.host);
  const sites = s.sites.includes(site) ? s.sites.filter((x) => x !== site) : [...s.sites, site];
  await chrome.storage.local.set({ sites });
  render();
};

$("toggleChannel").onclick = async () => {
  const s = await settings();
  const ch = info.channel;
  const on = s.channels.some((c) => c.id === ch.id);
  const channels = on ? s.channels.filter((c) => c.id !== ch.id) : [...s.channels, ch];
  await chrome.storage.local.set({ channels });
  render();
};

$("lipSync").onchange = (e) => chrome.storage.local.set({ lipSync: e.target.checked });

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
