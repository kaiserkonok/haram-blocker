# Haram Blocker

Removes music from videos in Chrome **live**, keeping only the voices.

- Every video's sound goes through an AI (Demucs `htdemucs_ft`, vocals model only) running on your own NVIDIA GPU. The music is thrown away and only the voice is played.
- The sound is cleaned *before* you hear it, so music never leaks. Each video starts with about 1 second of silence.
- The picture is held back by the same 1 second, so lips and voice stay matched (can be turned off in the menu).
- If the helper program isn't running, everything stays silent. It never fails open.
- Allowed list: sites and YouTube channels you trust play normally, with no cleaning and no delay. YouTube ads are always cleaned.

## Install (Linux, Chrome, NVIDIA GPU)

```sh
./install.sh
```

Then in Chrome:
1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose the `extension` folder

Chrome starts the helper automatically. The first start takes about 5 seconds, while the AI loads onto the GPU.

## How it works

```
video/audio on page ──► inject.js reroutes the sound (never reaches speakers directly)
                         │
                         ▼
                 worklet.js cuts it into 0.2 s pieces
                         │  bridge.js ─► background.js ─► native messaging
                         ▼
                 helper/host.py on the GPU: 4 s window, 0.4 s lookahead,
                 keeps only the vocals
                         │
                         ▼
                 worklet.js plays the voice exactly 1.0 s after capture
                 (silence if a piece isn't ready in time)
```

Cost on an RTX 5060 Ti: about 17–20% GPU and about 400 MB of VRAM while a video plays. Nothing runs while no video is playing.

## Tests

```sh
# helper only: voice quality, music leak, real-time timing
helper/.venv/bin/python helper/test_stream.py music.mp3 speech.wav
# full browser test (Playwright + Chromium)
python tests/e2e_test.py music.mp3 speech.wav
```

Last results: music-only audio comes out about 65 dB quieter (silent); speech passes through; the first second is silent; no gaps.

## Limits

- Singing counts as voice, so it stays. Only instruments and beats are removed.
- Chrome on this PC only.
- About 1 second delay at the start of each video and after seeking.
- Videos from other sites' servers without CORS (some TikTok videos) can't be read by Web Audio, so they play silent.
- If a site puts the `<video>` element itself into fullscreen, the lip-sync picture can't cover it. The voice is still cleaned, but lips may be 1 s ahead.

Logs: `~/.local/state/haram-blocker/helper.log`
