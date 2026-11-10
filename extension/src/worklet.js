// Runs on Chrome's real-time audio thread.
//
// Input: the page's original audio (it never reaches the speakers directly).
// It is cut into chunks and posted to the main thread, which sends them to the
// GPU helper. Cleaned (voice-only) audio comes back tagged with the absolute
// sample index it belongs to, and is played exactly `delay` samples after that
// sample was captured. Anything not ready in time is played as silence, so
// the original audio can never leak through.

class HaramCleaner extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.chunk = o.chunk; // frames per chunk sent to the helper
    this.delay = o.delay; // frames between capture and playback
    this.epoch = 0;
    this.frozen = false;
    this.n = 0; // absolute index of the next input frame

    this.inBuf = new Int16Array(this.chunk * 2);
    this.inFill = 0;
    this.chunkStart = 0;
    this.chunkPeak = 0;

    this.ringSize = Math.max(this.delay * 4, sampleRate * 4);
    this.ringL = new Float32Array(this.ringSize);
    this.ringR = new Float32Array(this.ringSize);
    this.ringIdx = new Float64Array(this.ringSize).fill(-1);

    this.stats = { missing: 0, played: 0, late: 0 };
    this.lastStats = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.t === "out") {
      if (m.epoch !== this.epoch) return;
      const rs = this.ringSize;
      const playFrom = this.n - this.delay; // older samples are already gone
      if (m.start + m.n <= playFrom) this.stats.late += m.n;
      const pcm = m.silent ? null : new Int16Array(m.pcm);
      for (let i = 0; i < m.n; i++) {
        const idx = m.start + i;
        if (idx < playFrom) continue;
        const pos = idx % rs;
        if (pcm) {
          this.ringL[pos] = pcm[2 * i] / 32768;
          this.ringR[pos] = pcm[2 * i + 1] / 32768;
        } else {
          this.ringL[pos] = 0;
          this.ringR[pos] = 0;
        }
        this.ringIdx[pos] = idx;
      }
    } else if (m.t === "freeze") {
      // Paused: the delay line stops instantly — no input taken, no output
      // played, clock held. Resuming continues exactly where it stopped.
      this.frozen = m.on;
    } else if (m.t === "flush") {
      // Seek / new video: drop everything queued so old audio never plays.
      this.epoch = m.epoch;
      this.ringIdx.fill(-1);
      this.inFill = 0;
      this.chunkPeak = 0;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const frames = out[0].length;
    if (this.frozen) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const inL = input.length > 0 ? input[0] : null;
    const inR = input.length > 1 ? input[1] : inL;

    // 1) Capture input into chunks.
    for (let i = 0; i < frames; i++) {
      if (this.inFill === 0) this.chunkStart = this.n + i;
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > this.chunkPeak) this.chunkPeak = al;
      if (ar > this.chunkPeak) this.chunkPeak = ar;
      const j = this.inFill * 2;
      this.inBuf[j] = Math.max(-32768, Math.min(32767, Math.round(l * 32768)));
      this.inBuf[j + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32768)));
      if (++this.inFill === this.chunk) {
        const msg = { t: "chunk", epoch: this.epoch, start: this.chunkStart, n: this.chunk };
        if (this.chunkPeak < 1e-5) {
          msg.silent = true;
          this.port.postMessage(msg);
        } else {
          const buf = this.inBuf.buffer;
          msg.pcm = buf;
          this.port.postMessage(msg, [buf]);
          this.inBuf = new Int16Array(this.chunk * 2);
        }
        this.inFill = 0;
        this.chunkPeak = 0;
      }
    }

    // 2) Play cleaned audio from `delay` frames ago; silence if not ready.
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : null;
    const rs = this.ringSize;
    for (let i = 0; i < frames; i++) {
      const idx = this.n + i - this.delay;
      let l = 0;
      let r = 0;
      if (idx >= 0) {
        const pos = idx % rs;
        if (this.ringIdx[pos] === idx) {
          l = this.ringL[pos];
          r = this.ringR[pos];
          this.ringIdx[pos] = -1;
          this.stats.played++;
        } else {
          this.stats.missing++;
        }
      }
      oL[i] = l;
      if (oR) oR[i] = r;
    }
    this.n += frames;

    if (currentTime - this.lastStats >= 2) {
      this.lastStats = currentTime;
      this.port.postMessage({ t: "stats", ...this.stats });
      this.stats = { missing: 0, played: 0, late: 0 };
    }
    return true;
  }
}

registerProcessor("haram-cleaner", HaramCleaner);
