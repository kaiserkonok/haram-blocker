<p align="center">
  <img src="docs/assets/logo.svg" width="96" height="96" alt="Haram Blocker logo">
</p>

<h1 align="center">Haram Blocker</h1>

<p align="center">
  <b>Watch any video without the music.</b><br>
  The music is removed live, on your own GPU, <i>before</i> a single note reaches your ears.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14b8a6" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome MV3">
  <img src="https://img.shields.io/badge/GPU-NVIDIA%20CUDA-76B900?logo=nvidia&logoColor=white" alt="NVIDIA CUDA">
  <img src="https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black" alt="Linux">
  <img src="https://img.shields.io/badge/runs-100%25%20offline-1f2328" alt="Runs offline">
</p>

---

Most music blockers listen first and act second. Music starts playing, the extension notices, and *then* it mutes. That first second is exactly the part you were trying to avoid.

Haram Blocker flips the order. Every video's sound goes through an AI model on your graphics card **before** it is played. The model separates the voice from the instruments, the instruments are thrown away, and you only ever hear the voice.

<p align="center">
  <img src="docs/assets/how-it-works.svg" width="880" alt="Typical blockers play about one second of music before removing it. Haram Blocker cleans the audio first, so the music is never heard.">
</p>

## Features

- **Zero leak by design.** The audio is cleaned before playback. If a piece isn't ready in time, you hear silence, never the original. If the helper crashes, everything stays silent.
- **Keeps the voice.** Talks, vlogs, podcasts, news and reels stay watchable. Only the instruments and beats disappear.
- **Lips stay in sync.** The picture is held back by the same second as the voice.
- **Works with blur extensions.** If an extension like HaramBlur blurs a video, the blur also covers Haram Blocker's delayed picture. Because that picture is shown 1 s late, a blur that reacts up to a second late still lands *before* you see the frame.
- **Instant controls.** Pause, play and scrolling to the next reel react immediately. Only a *new* video waits about a second while its voice is cleaned.
- **Works on any site.** It hooks every `<video>`, `<audio>` and Web Audio output in Chrome, not a list of supported sites. Tested on YouTube and YouTube Shorts; reports from other sites are welcome.
- **Hides images of the opposite gender (optional).** Pick "I am a man" or "I am a woman" in the menu. Every image starts covered (solid black by default, or blurred) and is shown only after the AI has checked it. Logos, icons and charts are recognised as harmless. Two strictness levels: strict (default) and balanced.
- **Allowed list.** Sites and YouTube channels you trust (Quran recitation, for example) play untouched, with no delay. Ads on allowed channels are still cleaned.
- **Private.** Everything runs on your machine. No servers, no accounts, no analytics, and nothing leaves your computer.

## Performance

Measured on an RTX 5060 Ti:

| | |
|---|---|
| Music removed | about **65 dB** quieter, effectively silent |
| Voice quality | live streaming matches whole-file separation |
| GPU while a video plays | about **17–20%**, **~22 W** extra, **~400–700 MB** VRAM (image check adds ~1 GB VRAM when on) |
| GPU when nothing is playing | **0%**. The card stays in its lowest power state. |
| Processing time per 0.2 s piece | about **35 ms**, well inside the 1 s budget |
| Image check | about **8–13 ms** per image; a page of 32 images is ready in ~0.6 s |
| Image check, quiz of ~2,300 photos + art + graphics never used in training | strict: **0.17%** of photos with a woman shown, **0.26%** with a man; logos/icons/charts ~1% hidden by mistake ([details](helper/training/README.md)) |

## Install

**You need:** Linux, Google Chrome (or Chromium or Brave), an NVIDIA GPU with a recent driver, and [`uv`](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/kaiserkonok/haram-blocker.git
cd haram-blocker
./install.sh
```

The script creates a Python environment with CUDA PyTorch (a large, one-time download), fetches the model, and registers the helper with Chrome.

Then load the extension:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the `extension` folder

That's it. Chrome starts the helper automatically, and it's ready about 5 seconds after Chrome opens. Click the extension icon to see its status and manage your allowed list.

> If you use another music-blocking extension, turn it off. Two extensions capturing the same audio will interfere with each other.

## How it works

```mermaid
flowchart LR
    A["Sound from<br/>the page"] -->|rerouted before<br/>the speakers| B["AudioWorklet<br/>0.2 s pieces"]
    B -->|native messaging| C["GPU helper<br/>Demucs vocals model"]
    C -->|voice only| D["AudioWorklet<br/>plays exactly 1.0 s<br/>after capture"]
    D --> E(("🔊"))
    F["Video frames"] -->|held 1.0 s| G["Canvas over the video"]
```

1. **Interception.** A content script runs before any page script and reroutes every media element and every Web Audio graph into a cleaner. Nothing can reach the speakers directly.
2. **Streaming separation.** An `AudioWorklet` cuts the sound into 0.2 s pieces and sends them, through the extension, to a local Python helper. The helper runs the vocals model of [Demucs](https://github.com/adefossez/demucs) (`htdemucs_ft`) over a sliding 4 s window with 0.4 s of look-ahead, so every returned sample was separated with context on both sides. Seams are crossfaded.
3. **Fixed-delay playback.** Each cleaned piece is tagged with the exact sample it belongs to and played 1.0 s after capture. Missing pieces play as silence. That fixed delay is what makes zero-leak possible.
4. **Lip sync.** Video frames are captured with `requestVideoFrameCallback` and drawn 1.0 s late onto a canvas that sits over the video.
5. **Instant controls.** Pausing freezes the whole delay line, sound and picture together. Resuming continues from the buffer, so there's no wait. Switching videos drops the queue at once.

### Image hiding

```mermaid
flowchart LR
    A["Page loads"] --> B["images.css covers<br/>every image"]
    B --> C["Small copy sent<br/>to the helper"]
    C --> D["Finder: Faster R-CNN<br/>where are the people?"]
    D --> E["Judge: classifiers on CLIP<br/>woman or man?"]
    E -->|"opposite gender<br/>or unsure"| F["stays covered"]
    E -->|clear| G["shown"]
```

The stylesheet is injected before the page draws, so images are covered from the first frame. The finder ([Faster R-CNN MobileNetV3](https://pytorch.org/vision/stable/models/faster_rcnn.html), torchvision) locates people. Two small classifiers trained on top of [CLIP](https://github.com/openai/CLIP) ViT-B/16 then decide: one looks at each person close up, the other at the whole image (catching drawings, paintings, body close-ups and people the finder missed). They were trained on audited, public data and tested on a separate quiz set; see [helper/training](helper/training/README.md). Images the page won't let the extension read are downloaded again by the extension, shrunk to 384 px and sent to the helper. Results are cached. Sound always takes priority on the GPU, so a page full of images never causes gaps in the voice.

<details>
<summary><b>Project layout</b></summary>

```
extension/
  manifest.json
  src/inject.js      page script: reroutes audio, lip-sync canvas, allowed list
  src/worklet.js     real-time chunking and fixed-delay playback
  src/images.js      sends images to be checked, shows the clear ones
  src/images.css     covers every image until it is checked
  src/bridge.js      connects the page to the extension
  src/background.js  keeps the GPU helper running, routes audio
  popup/             status and allowed list
helper/
  host.py            native messaging host, streaming separation on CUDA
  vision.py          image check: finder + judge
  test_stream.py     voice quality, music leak, real-time timing
  test_vision.py     image check accuracy on labeled photos
tests/
  e2e_test.py        full browser test: music removal, lip sync, controls
  e2e_images_test.py full browser test: images covered from the first frame
install.sh
```
</details>

## FAQ

**Does it remove singing?**
No. The model separates *vocals* from *instruments*, and a singing voice is a vocal. Instruments, beats and background scores are removed, but a song's singer remains.

**Why is there a one-second wait when a video starts?**
That's the time it takes to clean the audio before you hear it. It's the price of never hearing music. Pausing, resuming and scrolling stay instant.

**Does it run all the time?**
The model stays loaded in VRAM so videos start quickly, but it only computes while sound is actually playing. When nothing plays, GPU use is zero.

**Does it work without an NVIDIA GPU?**
Not yet. AMD (ROCm), Apple Silicon and CPU support are on the roadmap. On CPU, the model is too slow for live use today.

**Does it work on Windows or macOS?**
Not yet. The extension is cross-platform, and the helper only needs a different installer. Contributions are welcome.

**Why not just mute videos with music?**
Because most videos with background music are worth watching: lectures, vlogs, news, tutorials. Muting throws the voice away with the music.

## Limitations

- Linux + NVIDIA + Chromium-based browsers only, for now.
- Videos from servers that block cross-origin access (some TikTok CDNs) can't be read by Web Audio, so they play silent rather than unfiltered.
- Image hiding covers `<img>` and SVG images. CSS background images, video posters and images inside shadow DOM are not covered yet. Videos themselves are not checked for people yet.
- If a site puts the bare `<video>` element into fullscreen, the lip-sync canvas can't cover it. The audio is still cleaned, but the picture may run 1 s ahead.

## Roadmap

- [ ] Windows and macOS installers
- [ ] AMD / Apple Silicon / CPU backends
- [ ] Lower start delay (smaller pieces on fast GPUs)
- [ ] Check video frames for people, using the 1 s buffer that already exists
- [ ] CSS background images
- [ ] Firefox support
- [ ] Chrome Web Store release

## Development

```sh
# helper only: voice quality, music leak and real-time timing
helper/.venv/bin/python helper/test_stream.py music.mp3 speech.wav

# image check accuracy (eval.json lists photos with a female/male/mixed/none group)
helper/.venv/bin/python helper/test_vision.py eval.json photos/

# full browser tests (need Playwright and its Chromium)
python tests/e2e_test.py music.mp3 speech.wav
python tests/e2e_images_test.py eval.json photos/
```

The tests mix a speech recording over music, so the perfect answer is known. They check that the music-only part comes out silent, the voice comes through, the first second is silent, there are no gaps, and that pause, resume and video switching are instant.

Helper logs: `~/.local/state/haram-blocker/helper.log`

Issues and pull requests are welcome. If music ever leaks through, please open an issue with the video link.

## Credits

Source separation by [Demucs](https://github.com/adefossez/demucs) (Alexandre Défossez, Meta AI), MIT license. People detection by [torchvision](https://github.com/pytorch/vision) Faster R-CNN, BSD license. Image understanding by [CLIP](https://github.com/openai/CLIP) (OpenAI) via [OpenCLIP](https://github.com/mlfoundations/open_clip), MIT license. Image accuracy measured on [COCO](https://cocodataset.org) photos.

## License

[MIT](LICENSE)
