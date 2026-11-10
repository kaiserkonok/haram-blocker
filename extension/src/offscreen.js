// Haram Blocker — hidden page used only to draw SVG images so they can be
// checked (the background worker can't decode SVG).
chrome.runtime.onMessage.addListener((m, _sender, send) => {
  if (m.target !== "offscreen" || m.t !== "raster") return;
  (async () => {
    const url = URL.createObjectURL(new Blob([m.svg], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w0 = img.naturalWidth || 384;
      const h0 = img.naturalHeight || 384;
      const s = 384 / Math.max(w0, h0); // vector: draw at full check size
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w0 * s));
      c.height = Math.max(1, Math.round(h0 * s));
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; // transparent parts on white, like most pages
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      send({ data: c.toDataURL("image/jpeg", 0.85).split(",")[1] });
    } catch (e) {
      send({ error: String(e) });
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  return true;
});
