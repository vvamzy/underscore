# 🎤 Vocal Extractor

Turn any song into a **karaoke track** — remove the vocals, keep the music.
Everything runs **locally on your machine**; your audio never touches the internet.

![Python 3.9–3.12](https://img.shields.io/badge/Python-3.9–3.12-blue)
![Requires FFmpeg](https://img.shields.io/badge/requires-FFmpeg-orange)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows-lightgrey)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

> 💡 Screenshot slot — drop one into `docs/screenshot.png` and it appears here:
>
> <img src="docs/screenshot.png" alt="Vocal Extractor UI" width="720"/>

---

## ✨ Features

- **Drop a song, get the karaoke version** — drag & drop, waveform preview, instant playback, WAV/MP3 download.
- **Two separation engines**, from fast to studio-grade:

| Mode | Where it runs | Quality | Speed |
|---|---|---|---|
| ⚡ **Instant** | Web Audio, right in your tab | Good — phase-accurate centre-channel cancellation | ~1 second, zero setup |
| 🧠 **AI Studio** | Local Python server running Meta's **Demucs** neural net | Studio-grade true vocal/instrumental separation | Seconds on GPU · minutes on CPU |

- **Private by design** — binds to `127.0.0.1`, no cloud calls, no telemetry.

## 🚀 Quick start (Windows)

```powershell
# 1) One-time setup (installs Python packages, ~250 MB)
powershell -ExecutionPolicy Bypass -File setup.ps1

# 2) Every day after that
powershell -ExecutionPolicy Bypass -File start.ps1
```

`start.ps1` prints the URL and opens **http://localhost:8000** automatically.
Then: **drop an audio file → pick a mode → extract karaoke → download**.

> Have an NVIDIA GPU? Rerun `setup.ps1 -Gpu` once (~2.5 GB CUDA download) and AI
> separation becomes roughly 10× faster.

## 📋 Prerequisites

- **Python 3.9 – 3.12** (auto-detected during setup; 3.11 recommended)
- **FFmpeg** on your `PATH` (used to decode uploads and export MP3s)
- A modern browser (Chrome / Edge / Firefox)

## 🧠 How it works

### ⚡ Instant mode (no server needed)
Vocals sit in the **centre** of a stereo mix — identical in both speakers. This mode
extracts the centre signal, high-passes it (~150 Hz so the bass survives) with a
*phase-accurate* (filtfilt) filter, and subtracts it from both channels — the classic
karaoke trick, made deeper (~15–20 dB of cancellation). Instant, offline, private.

*Needs a **stereo** file.* Anything else panned centre (bass, snare, reverb) gets
softened too, so results vary with the mix. Use the strength slider to tune it.

### 🧠 AI Studio mode (Demucs)
`server.py` accepts your file, normalises it with FFmpeg, and runs
[`demucs`](https://github.com/facebookresearch/demucs) (`--two-stems=vocals`) to produce
a real **instrumental** and an **isolated vocals** stem. Two models are selectable:

- `htdemucs` — fast, great default
- `htdemucs_ft` — fine-tuned, noticeably better on hard mixes, ~4× slower

The **first AI run downloads the model (~90 MB)** automatically; later runs are fully offline.

## 🗂️ Project structure

```
vocal-extractor/
├── web/                 the website (vanilla HTML/CSS/JS, no build step)
│   ├── index.html
│   └── assets/
├── server.py            local API: serves the site + runs Demucs jobs (FastAPI)
├── requirements.txt     Python dependencies
├── setup.ps1            one-time install (use -Gpu for NVIDIA)
├── start.ps1            start server & open the browser
└── output/              separation results (created automatically, git-ignored)
```

## 🛠️ Tech stack

- Frontend: vanilla HTML/CSS/JS + Web Audio API (no frameworks, no build step)
- Backend: **FastAPI** + job queue (one separation at a time) + streaming progress
- Separation: **Demucs / htdemucs** (PyTorch), and a hand-rolled DSP centre-cancellation path
- Audio I/O: FFmpeg

## 🔒 Privacy

- The web server listens on **127.0.0.1** (your computer only).
- Audio files are stored in `output/<job-id>/` and deleted with the job prune logic;
  clear the folder any time.
- No analytics, no cloud calls, no telemetry.

## 🧯 Troubleshooting

| Problem | Fix |
|---|---|
| *"Running scripts is disabled on this system"* | Use the full command including `-ExecutionPolicy Bypass`. |
| *"AI server offline"* pill | Run `start.ps1` (server binds to `127.0.0.1:8000`). |
| *"Demucs not installed yet"* | Run `setup.ps1` once, then restart `start.ps1`. |
| Port 8000 already in use | Close the other program or edit the port in `start.ps1`. |
| Instant mode says **mono file** | The source has 1 channel — cancellation is impossible; use AI mode. |
| GPU out of memory (4 GB cards) | The server auto-retries on CPU; or choose the `Fast` model. |
| First AI run is slow | That's the one-time ~90 MB model download — cached afterwards. |

## 📄 License

[MIT](LICENSE) © 2026 vvamzy