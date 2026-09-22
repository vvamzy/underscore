/* ============================================================
   Vocal Extractor — frontend
   Two engines:
     ⚡ Instant : centre-channel cancellation, runs in the browser
     🧠 AI      : Demucs via the local server (server.py)
   ============================================================ */

(() => {
  "use strict";

  /* -------------------- helpers -------------------- */
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tick = () => sleep(0);

  // Same-origin when served by the local server, otherwise talk to localhost.
  const API = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(location.origin)
    ? ""
    : "http://localhost:8000";

  const MAX_BYTES = 300 * 1024 * 1024;

  const el = {
    pill: $("serverPill"), pillDot: $("serverDot"), pillText: $("serverText"),
    dropzone: $("dropzone"), fileInput: $("fileInput"),
    workspace: $("workspace"),
    errorBanner: $("errorBanner"), errorText: $("errorText"), errorClose: $("errorClose"),
    trackName: $("trackName"), trackSub: $("trackSub"), resetBtn: $("resetBtn"),
    wave: $("wave"),
    playBtn: $("playBtn"), iconPlay: $("iconPlay"), iconPause: $("iconPause"),
    curTime: $("curTime"), durTime: $("durTime"), stemChips: $("stemChips"), vol: $("vol"),
    tabInstant: $("tabInstant"), tabAi: $("tabAi"),
    panelInstant: $("panelInstant"), panelAi: $("panelAi"),
    strength: $("strength"), strengthVal: $("strengthVal"), instantBtn: $("instantBtn"),
    modelSel: $("modelSel"), aiHint: $("aiHint"), aiBtn: $("aiBtn"),
    deviceSel: $("deviceSel"),
    jobBox: $("jobBox"), jobLabel: $("jobLabel"), jobPct: $("jobPct"),
    jobProgress: $("jobProgress"), jobBar: $("jobBar"), jobLog: $("jobLog"),
    queueCard: $("queueCard"), queueSub: $("queueSub"), queueList: $("queueList"),
    results: $("results"), resultsTitle: $("resultsTitle"), resultsSub: $("resultsSub"),
    karaokeMeta: $("karaokeMeta"), vocalsTitle: $("vocalsTitle"),
    vocalsMeta: $("vocalsMeta"), originalMeta: $("originalMeta"),
    player: $("player"),
  };

  const state = {
    file: null,
    base: "track",
    buffer: null,
    peaks: null,
    stems: { original: null, karaoke: null, vocals: null },
    active: "original",
    processing: false,
    hoverX: null,
    dragging: false,
    raf: 0,
    server: { online: false, demucs: false, device: null, detecting: true, cuda: false },
    currentJob: null,
    urls: [],
  };

  /* -------------------- misc UI -------------------- */
  function banner(msg, kind = "error") {
    el.errorText.textContent = msg;
    el.errorBanner.classList.toggle("info", kind === "info");
    el.errorBanner.classList.remove("hidden");
  }
  const hideBanner = () => el.errorBanner.classList.add("hidden");
  el.errorClose.addEventListener("click", hideBanner);

  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const fmtSize = (b) =>
    b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

  /* -------------------- AI server status -------------------- */
  async function checkHealth() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${API}/api/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error("bad status");
      const h = await res.json();
      state.server = {
        online: true,
        demucs: !!h.demucs,
        device: h.device,
        detecting: !!h.detecting,
        cuda: !!h.cuda,
      };
    } catch {
      state.server = { online: false, demucs: false, device: null, detecting: false, cuda: false };
    }
    renderServer();
    refreshQueue();
  }

  function renderDeviceSelect() {
    const gpuOpt = el.deviceSel && el.deviceSel.querySelector('option[value="gpu"]');
    if (gpuOpt) {
      gpuOpt.disabled = !state.server.cuda;
      gpuOpt.textContent = state.server.cuda ? "GPU (CUDA)" : "GPU — not installed (run setup.ps1 -Gpu)";
    }
    if (el.deviceSel) el.deviceSel.disabled = !state.server.online || state.processing;
  }

  el.deviceSel.addEventListener("change", () => {
    try { localStorage.setItem("ve.device", el.deviceSel.value); } catch { /* ignore */ }
    renderServer();
  });

  function renderServer() {
    const s = state.server;
    el.pill.classList.toggle("online", s.online);
    el.pill.classList.toggle("offline", !s.online);
    renderDeviceSelect();

    if (s.online) {
      el.pillDot.classList.toggle("cpu", s.device !== "cuda");
      el.pillText.textContent =
        s.detecting ? "AI server · warming up…" : `AI server · ${s.device === "cuda" ? "GPU" : "CPU"}`;
    } else {
      el.pillDot.classList.remove("cpu");
      el.pillText.textContent = "AI server offline";
    }

    // MP3 export requires ffmpeg on the server.
    document.querySelectorAll(".mp3-btn").forEach((b) => b.classList.toggle("hidden", !s.online));

    // AI panel hint
    el.aiHint.classList.remove("warn", "error", "ok");
    if (!s.online) {
      el.aiHint.classList.add("error");
      el.aiHint.innerHTML =
        "<strong>AI server not detected.</strong> Start it with <code>start.ps1</code> — " +
        "it will connect automatically. Meanwhile, the ⚡ Instant tab works with no server at all.";
      el.aiBtn.disabled = true;
    } else if (!s.demucs) {
      el.aiHint.classList.add("warn");
      el.aiHint.innerHTML =
        "Server is up, but the AI model isn’t installed yet. Run <code>setup.ps1</code> once, then reload.";
      el.aiBtn.disabled = true;
    } else if (s.detecting) {
      el.aiHint.classList.add("warn");
      el.aiHint.textContent = "Warming up — detecting GPU… (first launch takes a few seconds)";
      el.aiBtn.disabled = state.processing;
    } else {
      el.aiHint.classList.add("ok");
      const dev = s.device === "cuda" ? "GPU (CUDA)" : "CPU";
      el.aiHint.innerHTML =
        `Ready — Demucs on <strong>${dev}</strong>. A song takes seconds on GPU or a few minutes on CPU. ` +
        "The very first run also downloads the model (~90 MB).";
      el.aiBtn.disabled = state.processing;
    }
  }

  /* -------------------- engine tabs -------------------- */
  function selectTab(which) {
    const ai = which === "ai";
    el.tabInstant.classList.toggle("active", !ai);
    el.tabAi.classList.toggle("active", ai);
    el.panelInstant.classList.toggle("hidden", ai);
    el.panelAi.classList.toggle("hidden", !ai);
    if (ai && !state.server.online) checkHealth();
  }
  el.tabInstant.addEventListener("click", () => selectTab("instant"));
  el.tabAi.addEventListener("click", () => selectTab("ai"));

  /* -------------------- job progress UI -------------------- */
  function jobShow(label, pct = 0, indeterminate = false) {
    el.jobBox.classList.remove("hidden");
    el.jobLabel.textContent = label;
    el.jobBar.style.width = `${pct}%`;
    el.jobPct.textContent = indeterminate ? "" : `${pct}%`;
    el.jobProgress.classList.toggle("indeterminate", indeterminate);
    el.jobLog.textContent = "";
  }
  function jobUpdate({ label, pct, indeterminate, log }) {
    if (label) el.jobLabel.textContent = label;
    if (typeof indeterminate === "boolean") {
      el.jobProgress.classList.toggle("indeterminate", indeterminate);
      if (indeterminate) el.jobPct.textContent = "";
    }
    if (typeof pct === "number") {
      el.jobBar.style.width = `${pct}%`;
      if (!el.jobProgress.classList.contains("indeterminate")) el.jobPct.textContent = `${pct}%`;
    }
    if (log) el.jobLog.textContent = log;
  }
  const jobHide = () => el.jobBox.classList.add("hidden");

  function setProcessing(on) {
    state.processing = on;
    el.instantBtn.disabled = on;
    el.aiBtn.disabled = on;
    el.tabInstant.disabled = on;
    el.tabAi.disabled = on;
    el.resetBtn.disabled = on;
    el.strength.disabled = on;
    el.modelSel.disabled = on;
    el.deviceSel.disabled = on || !state.server.online;
    if (on) hideBanner();
    else renderServer();
  }

  /* -------------------- file loading -------------------- */
  el.dropzone.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); }
  });
  el.fileInput.addEventListener("change", () => {
    if (el.fileInput.files && el.fileInput.files[0]) loadFile(el.fileInput.files[0]);
    el.fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((t) =>
    el.dropzone.addEventListener(t, (e) => { e.preventDefault(); el.dropzone.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((t) =>
    el.dropzone.addEventListener(t, (e) => { e.preventDefault(); el.dropzone.classList.remove("drag"); })
  );
  el.dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  // Also accept drops anywhere on the page while the dropzone is visible.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!el.dropzone.classList.contains("hidden")) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    }
  });

  async function loadFile(file) {
    hideBanner();
    if (file.size > MAX_BYTES) {
      banner("That file is over 300 MB — please trim it or use a smaller file.");
      return;
    }
    el.trackName.textContent = file.name;
    el.trackSub.textContent = "decoding…";
    el.dropzone.classList.add("hidden");
    el.workspace.classList.remove("hidden");
    setProcessing(true);
    jobShow("Decoding audio in your browser…", 0, true);

    try {
      const ab = await file.arrayBuffer();
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const buf = await ctx.decodeAudioData(ab);
      ctx.close();

      resetStems();
      state.file = file;
      state.base = file.name.replace(/\.[^.]+$/, "") || "track";
      state.buffer = buf;
      state.peaks = computePeaks(buf, 1600);

      const ext = (file.name.split(".").pop() || "?").toUpperCase();
      el.trackSub.textContent =
        `${ext} · ${fmtTime(buf.duration)} · ${buf.sampleRate} Hz · ` +
        `${buf.numberOfChannels === 1 ? "mono" : buf.numberOfChannels + " ch"} · ${fmtSize(file.size)}`;
      el.originalMeta.textContent = `${ext} · ${fmtTime(buf.duration)} · ${fmtSize(file.size)}`;

      state.stems.original = { url: URL.createObjectURL(file), blob: file };
      state.active = "original";
      el.player.src = state.stems.original.url;
      el.player.load();
      el.durTime.textContent = fmtTime(buf.duration);
      el.curTime.textContent = "0:00";

      resetChips();
      el.results.classList.add("hidden");
      jobHide();
      setProcessing(false);
      drawWave();

      if (buf.numberOfChannels < 2) {
        banner(
          "This is a mono file. ⚡ Instant mode needs stereo to cancel the centre channel — " +
          "the 🧠 AI Studio mode still works perfectly on mono tracks.",
          "info"
        );
      }
    } catch (err) {
      jobHide();
      setProcessing(false);
      el.workspace.classList.add("hidden");
      el.dropzone.classList.remove("hidden");
      banner(
        `Couldn't decode that file (${err && err.message ? err.message : "unsupported format"}). ` +
        "Try MP3, WAV, FLAC, M4A or OGG."
      );
    }
  }

  function resetChips() {
    el.stemChips.querySelectorAll(".chip").forEach((c) => {
      const key = c.dataset.stem;
      c.classList.toggle("active", key === state.active);
      c.disabled = key !== "original" && !state.stems[key];
    });
  }

  function resetStems() {
    ["karaoke", "vocals"].forEach((k) => {
      state.stems[k] = null;
    });
  }

  el.resetBtn.addEventListener("click", () => {
    el.player.pause();
    el.player.removeAttribute("src");
    el.player.load();
    state.urls.forEach((u) => URL.revokeObjectURL(u));
    state.urls = [];
    resetStems();
    state.stems.original = null;
    state.buffer = null;
    state.peaks = null;
    state.file = null;
    state.active = "original";
    el.workspace.classList.add("hidden");
    el.dropzone.classList.remove("hidden");
    hideBanner();
    cancelAnimationFrame(state.raf);
    updatePlayIcon();
  });

  /* -------------------- peaks + waveform -------------------- */
  function computePeaks(buffer, count) {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const block = Math.max(1, Math.floor(buffer.length / count));
    const peaks = new Float32Array(count);
    let max = 0;
    for (let i = 0; i < count; i++) {
      const start = i * block;
      const end = Math.min(start + block, buffer.length);
      let m = 0;
      for (let j = start; j < end; j++) {
        let v = Math.abs(ch0[j]);
        if (ch1) { const w = Math.abs(ch1[j]); if (w > v) v = w; }
        if (v > m) m = v;
      }
      peaks[i] = m;
      if (m > max) max = m;
    }
    if (max > 0) for (let i = 0; i < count; i++) peaks[i] /= max;
    return peaks;
  }

  let playedGrad = null;
  let gradW = 0;

  function drawWave() {
    const canvas = el.wave;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      playedGrad = null;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.peaks) return;

    const dur = el.player.duration || (state.buffer && state.buffer.duration) || 0;
    const progress = dur ? el.player.currentTime / dur : 0;

    if (!playedGrad || gradW !== w) {
      playedGrad = ctx.createLinearGradient(0, 0, w, 0);
      playedGrad.addColorStop(0, "#8b5cf6");
      playedGrad.addColorStop(0.6, "#ec4899");
      playedGrad.addColorStop(1, "#22d3ee");
      gradW = w;
    }

    const step = 4; // 3px bar + 1px gap
    const bars = Math.max(1, Math.floor(w / step));
    const peaks = state.peaks;
    const mid = h / 2;

    for (let i = 0; i < bars; i++) {
      const p = peaks[Math.min(peaks.length - 1, Math.floor((i / bars) * peaks.length))];
      const bh = Math.max(2, p * (h - 16));
      const x = i * step;
      const played = i / bars <= progress;
      ctx.fillStyle = played ? playedGrad : "rgba(255,255,255,0.15)";
      ctx.fillRect(x, mid - bh / 2, 3, bh);
    }

    // centre line
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, mid - 0.5, w, 1);

    // playhead
    if (progress > 0) {
      const px = Math.min(w - 1, progress * w);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(px, 0, 1.5, h);
    }

    // hover
    if (state.hoverX != null) {
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillRect(Math.min(w - 1, state.hoverX), 0, 1, h);
    }
  }

  function seekFromEvent(e) {
    const rect = el.wave.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = el.player.duration;
    if (isFinite(dur)) el.player.currentTime = frac * dur;
    el.curTime.textContent = fmtTime(el.player.currentTime);
    drawWave();
  }

  el.wave.addEventListener("pointerdown", (e) => {
    state.dragging = true;
    el.wave.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  el.wave.addEventListener("pointermove", (e) => {
    const rect = el.wave.getBoundingClientRect();
    if (state.dragging) {
      seekFromEvent(e);
    } else {
      state.hoverX = e.clientX - rect.left;
      drawWave();
    }
  });
  el.wave.addEventListener("pointerup", () => { state.dragging = false; });
  el.wave.addEventListener("pointercancel", () => { state.dragging = false; });
  el.wave.addEventListener("pointerleave", () => {
    state.hoverX = null;
    if (!state.dragging) drawWave();
  });

  /* -------------------- transport -------------------- */
  function updatePlayIcon() {
    const playing = !el.player.paused && !el.player.ended;
    el.iconPlay.classList.toggle("hidden", playing);
    el.iconPause.classList.toggle("hidden", !playing);
  }

  function loop() {
    el.curTime.textContent = fmtTime(el.player.currentTime);
    drawWave();
    if (!el.player.paused && !el.player.ended) state.raf = requestAnimationFrame(loop);
  }

  el.playBtn.addEventListener("click", () => {
    if (el.player.paused || el.player.ended) el.player.play().catch(() => {});
    else el.player.pause();
  });
  el.player.addEventListener("play", () => {
    updatePlayIcon();
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(loop);
  });
  el.player.addEventListener("pause", () => {
    updatePlayIcon();
    cancelAnimationFrame(state.raf);
    el.curTime.textContent = fmtTime(el.player.currentTime);
    drawWave();
  });
  el.player.addEventListener("ended", updatePlayIcon);
  el.player.addEventListener("timeupdate", () => {
    if (el.player.paused) {
      el.curTime.textContent = fmtTime(el.player.currentTime);
      drawWave();
    }
  });
  el.player.addEventListener("loadedmetadata", () => {
    if (isFinite(el.player.duration)) el.durTime.textContent = fmtTime(el.player.duration);
  });
  el.player.addEventListener("error", () => {
    if (state.file) banner("The browser couldn't play this format. Try converting it to MP3 or WAV first.");
  });
  el.vol.addEventListener("input", () => { el.player.volume = Number(el.vol.value); });

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "BUTTON" || t.tagName === "TEXTAREA")) return;
    if (el.workspace.classList.contains("hidden")) return;
    e.preventDefault();
    if (el.player.paused) el.player.play().catch(() => {});
    else el.player.pause();
  });

  /* -------------------- stem switching -------------------- */
  function switchStem(key) {
    const stem = state.stems[key];
    if (!stem || key === state.active) return;
    const t = el.player.currentTime;
    const wasPlaying = !el.player.paused && !el.player.ended;
    el.player.pause();
    state.active = key;
    resetChips();

    const onMeta = () => {
      el.player.removeEventListener("loadedmetadata", onMeta);
      try {
        const d = el.player.duration;
        if (isFinite(d)) el.player.currentTime = Math.max(0, Math.min(t, d - 0.05));
      } catch { /* ignore */ }
      el.curTime.textContent = fmtTime(el.player.currentTime);
      if (wasPlaying) el.player.play().catch(() => {});
      drawWave();
    };
    el.player.addEventListener("loadedmetadata", onMeta);
    el.player.src = stem.url;
    el.player.load();
  }

  el.stemChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip && !chip.disabled) switchStem(chip.dataset.stem);
  });

  function setStem(key, blob, metaText) {
    const old = state.stems[key];
    if (old && old.url) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(blob);
    state.urls.push(url);
    state.stems[key] = { url, blob };
    resetChips();
    if (key === "karaoke" && metaText) el.karaokeMeta.textContent = metaText;
    if (key === "vocals" && metaText) el.vocalsMeta.textContent = metaText;
  }

  /* -------------------- WAV encoding (instant mode) -------------------- */
  function encodeWav(chL, chR, sr) {
    const n = chL.length;
    const bytes = 44 + n * 2 * 2;
    const ab = new ArrayBuffer(bytes);
    const dv = new DataView(ab);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, bytes - 8, true); str(8, "WAVE");
    str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true);
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, n * 4, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      let l = Math.max(-1, Math.min(1, chL[i]));
      let r = Math.max(-1, Math.min(1, chR[i]));
      dv.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true); off += 2;
      dv.setInt16(off, r < 0 ? r * 0x8000 : r * 0x7fff, true); off += 2;
    }
    return new Blob([ab], { type: "audio/wav" });
  }

  /* -------------------- ⚡ instant separation -------------------- */
  el.strength.addEventListener("input", () => {
    el.strengthVal.textContent = `${el.strength.value}%`;
  });

  el.instantBtn.addEventListener("click", async () => {
    if (state.processing) return;
    hideBanner();

    const buf = state.buffer;
    if (!buf) return;
    if (buf.numberOfChannels < 2) {
      banner("⚡ Instant mode needs a stereo file. Use the 🧠 AI Studio tab for mono tracks.");
      return;
    }

    setProcessing(true);
    jobShow("Cancelling centre channel…", 0);
    await tick();

    try {
      const strength = Number(el.strength.value) / 100;
      const sr = buf.sampleRate;
      const n = buf.length;
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      const outL = new Float32Array(n);
      const outR = new Float32Array(n);
      const outV = new Float32Array(n);

      // Bilinear RC high-pass (~150 Hz) of the centre signal, applied twice
      // (filtfilt = forward + backward pass) so it is phase-accurate. Removing
      // a phase-accurate copy of the centre gives ~15–20 dB of vocal
      // cancellation, while bass and off-centre music survive.
      const fc = 150;
      const wc = 2 * Math.PI * fc;
      const k = 2 * sr;
      const a0 = k / (k + wc);
      const a1 = -k / (k + wc);
      const b1 = (k - wc) / (k + wc);
      const hp = new Float32Array(n);
      let xPrev = 0;
      let yPrev = 0;
      const CHUNK = 1 << 18;

      // 1/3 forward pass
      let i = 0;
      while (i < n) {
        const end = Math.min(i + CHUNK, n);
        for (; i < end; i++) {
          const mid = (L[i] + R[i]) * 0.5;
          const y = a0 * mid + a1 * xPrev + b1 * yPrev;
          xPrev = mid;
          yPrev = y;
          hp[i] = y;
        }
        jobUpdate({ pct: Math.round((i / n) * 40), label: "Analysing centre channel…" });
        await tick();
        if (state.buffer !== buf) throw new Error("cancelled");
      }

      // 2/3 backward pass — makes the filter phase-linear
      xPrev = 0;
      yPrev = 0;
      let j = n - 1;
      while (j >= 0) {
        const start = Math.max(0, j - CHUNK + 1);
        for (; j >= start; j--) {
          const x = hp[j];
          const y = a0 * x + a1 * xPrev + b1 * yPrev;
          xPrev = x;
          yPrev = y;
          hp[j] = y;
        }
        jobUpdate({ pct: Math.round(((n - 1 - j) / n) * 44 + 40), label: "Refining centre channel…" });
        await tick();
        if (state.buffer !== buf) throw new Error("cancelled");
      }

      // 3/3 subtract & build stems
      i = 0;
      while (i < n) {
        const end = Math.min(i + CHUNK, n);
        for (; i < end; i++) {
          outL[i] = L[i] - strength * hp[i];
          outR[i] = R[i] - strength * hp[i];
          outV[i] = hp[i];
        }
        jobUpdate({ pct: Math.round((i / n) * 8 + 84), label: "Building karaoke track…" });
        await tick();
        if (state.buffer !== buf) throw new Error("cancelled");
      }

      jobUpdate({ pct: 92, label: "Encoding WAV…" });
      await tick();
      const karaoke = encodeWav(outL, outR, sr);
      jobUpdate({ pct: 96 });
      await tick();
      const vocals = encodeWav(outV, outV, sr);
      jobUpdate({ pct: 100, label: "Done" });
      await tick();

      setStem("karaoke", karaoke, `Centre-cancellation instrumental · ${fmtTime(buf.duration)}`);
      setStem("vocals", vocals, `Centre channel (approximate) · ${fmtTime(buf.duration)}`);

      el.vocalsTitle.innerHTML = 'Vocals <span class="tag">centre channel</span>';
      el.resultsTitle.textContent = "🎉 Instant karaoke ready";
      el.resultsSub.textContent =
        "Processed entirely in your browser. For a cleaner, full-quality instrumental, try the 🧠 AI Studio tab.";
      el.results.classList.remove("hidden");
      switchStem("karaoke");
      jobHide();
    } catch (err) {
      jobHide();
      if (String(err && err.message) !== "cancelled") {
        banner(`Instant extraction failed: ${err && err.message ? err.message : err}`);
      }
    } finally {
      setProcessing(false);
    }
  });

  /* -------------------- 🧠 AI separation -------------------- */
  async function readError(res) {
    try {
      const txt = await res.text();
      try { return JSON.parse(txt).detail || txt; } catch { return txt; }
    } catch { return `HTTP ${res.status}`; }
  }

  el.aiBtn.addEventListener("click", async () => {
    if (state.processing || !state.file) return;
    hideBanner();
    if (!state.server.online) {
      await checkHealth();
      if (!state.server.online) {
        banner("Can't reach the AI server. Run start.ps1 in the vocal-extractor folder, then try again.");
        return;
      }
    }

    setProcessing(true);
    jobShow("Uploading track to the local server…", 2, true);

    try {
      const fd = new FormData();
      fd.append("file", state.file, state.file.name);
      const res = await fetch(
        `${API}/api/separate?model=${encodeURIComponent(el.modelSel.value)}&device=${encodeURIComponent(el.deviceSel.value)}`,
        { method: "POST", body: fd }
      );
      if (!res.ok) throw new Error(await readError(res));
      const { job_id } = await res.json();
      state.currentJob = job_id;
      refreshQueue();

      const model = el.modelSel.value === "htdemucs_ft" ? "Fine-tuned Demucs" : "Demucs";

      for (;;) {
        await sleep(900);
        const r = await fetch(`${API}/api/jobs/${job_id}`);
        if (!r.ok) throw new Error("Lost track of the job (server restarted?)");
        const j = await r.json();

        if (j.status === "queued") {
          jobUpdate({
            label: j.position > 1 ? `Waiting in queue (${j.position})…` : "Waiting for the server…",
            indeterminate: true,
            log: j.detail,
          });
        } else if (j.status === "running") {
          jobUpdate({
            label: `Separating with ${model}…`,
            pct: typeof j.percent === "number" ? j.percent : undefined,
            indeterminate: typeof j.percent !== "number",
            log: j.detail,
          });
        } else if (j.status === "cancelled") {
          jobUpdate({ label: "Cancelled", pct: 0, log: j.detail });
          banner("Separation cancelled — nothing was saved.", "info");
          break;
        } else if (j.status === "error") {
          throw new Error(j.detail || "Separation failed");
        } else if (j.status === "done") {
          jobUpdate({ label: "Downloading stems…", indeterminate: true, pct: undefined });
          const kRes = await fetch(API + j.result.karaoke);
          const vRes = await fetch(API + j.result.vocals);
          if (!kRes.ok || !vRes.ok) throw new Error("Couldn't download the results");
          const kBlob = await kRes.blob();
          const vBlob = await vRes.blob();

          const dur = state.buffer ? fmtTime(state.buffer.duration) : "";
          setStem("karaoke", kBlob, `Demucs instrumental · ${dur}`);
          setStem("vocals", vBlob, `Demucs isolated vocals · ${dur}`);

          el.vocalsTitle.innerHTML = 'Vocals <span class="tag green">AI isolated</span>';
          el.resultsTitle.textContent = "🎉 AI separation complete";
          el.resultsSub.textContent =
            "Demucs rebuilt the instrumental and isolated the vocals. Preview above, download below.";
          el.results.classList.remove("hidden");
          switchStem("karaoke");
          jobUpdate({ label: "Done", pct: 100 });
          break;
        }
      }
      jobHide();
    } catch (err) {
      jobHide();
      banner(
        `AI extraction failed: ${err && err.message ? err.message : err} ` +
        "— check the start.ps1 window for details."
      );
    } finally {
      state.currentJob = null;
      refreshQueue();
      setProcessing(false);
    }
  });

  /* -------------------- results: listen + download -------------------- */
  document.querySelectorAll("[data-listen]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.listen;
      if (!state.stems[key]) return;
      switchStem(key);
      setTimeout(() => el.player.play().catch(() => {}), 60);
    });
  });

  function anchorDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  document.querySelectorAll("[data-download]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.download;
      const fmt = btn.dataset.fmt;
      const stem = state.stems[key];
      if (!stem) return;
      const base = state.base;

      try {
        if (fmt === "source") {
          const url = URL.createObjectURL(state.file);
          anchorDownload(url, state.file.name);
          setTimeout(() => URL.revokeObjectURL(url), 30000);
          return;
        }
        if (fmt === "wav") {
          anchorDownload(stem.url, `${base}_${key}.wav`);
          return;
        }
        if (fmt === "mp3") {
          if (!state.server.online) {
            banner("MP3 export needs the local server — start it with start.ps1 (WAV download works without it).");
            return;
          }
          const original = btn.textContent;
          btn.disabled = true;
          btn.textContent = "…";
          try {
            const fd = new FormData();
            fd.append("file", stem.blob, `${key}.wav`);
            const res = await fetch(`${API}/api/mp3?name=${encodeURIComponent(`${base}_${key}`)}`, {
              method: "POST",
              body: fd,
            });
            if (!res.ok) throw new Error(await readError(res));
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            anchorDownload(url, `${base}_${key}.mp3`);
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          } finally {
            btn.disabled = false;
            btn.textContent = original;
          }
        }
      } catch (err) {
        banner(`Download failed: ${err && err.message ? err.message : err}`);
      }
    });
  });

  /* -------------------- server queue panel -------------------- */
  const Q_MODEL = { htdemucs: "Demucs", htdemucs_ft: "Demucs FT" };

  function qBtn(label, act) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small ghost q-btn";
    b.dataset.act = act;
    b.textContent = label;
    return b;
  }

  function queueRow(j, mine) {
    const wrap = document.createElement("div");
    wrap.className = "queue-row" + (mine ? " mine" : "");
    wrap.dataset.jid = j.id;

    const name = document.createElement("span");
    name.className = "q-name";
    name.textContent = (mine ? "↑ " : "") + (j.filename || "(file)");

    const chip = document.createElement("span");
    chip.className = `q-chip ${j.paused ? "paused" : j.status}`;
    chip.textContent = j.paused ? "paused" : j.status;

    const prog = document.createElement("div");
    prog.className = "q-progress";
    const bar = document.createElement("div");
    const pct = typeof j.percent === "number" ? j.percent : 0;
    bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    prog.appendChild(bar);

    const meta = document.createElement("span");
    meta.className = "q-meta";
    const parts = [Q_MODEL[j.model] || j.model];
    if (j.device_used) parts.push(j.device_used.toUpperCase());
    if (j.status === "queued" && j.position > 1) parts.push(`waiting · #${j.position}`);
    meta.textContent = parts.join(" · ");

    const acts = document.createElement("div");
    acts.className = "q-actions";
    if (j.status === "running") {
      acts.appendChild(qBtn(j.paused ? "▶ Resume" : "⏸ Pause", j.paused ? "resume" : "pause"));
      acts.appendChild(qBtn("✕ Cancel", "cancel"));
    } else if (j.status === "queued") {
      acts.appendChild(qBtn("✕ Cancel", "cancel"));
    }

    wrap.append(name, chip, prog, meta, acts);
    return wrap;
  }

  function renderQueue(jobs) {
    if (!state.server.online || !jobs.length) {
      el.queueCard.classList.add("hidden");
      return;
    }
    el.queueCard.classList.remove("hidden");
    const active = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
    el.queueSub.textContent = `${active} active · ${jobs.length - active} finished`;
    el.queueList.textContent = "";
    jobs.forEach((j) => el.queueList.appendChild(queueRow(j, state.currentJob === j.id)));
  }

  async function refreshQueue() {
    if (!state.server.online) {
      el.queueCard.classList.add("hidden");
      return;
    }
    try {
      const res = await fetch(`${API}/api/queue`);
      if (!res.ok) throw new Error("bad queue response");
      const data = await res.json();
      renderQueue(Array.isArray(data.jobs) ? data.jobs : []);
    } catch {
      // transient — keep last render, hide only when really offline
      if (!state.server.online) el.queueCard.classList.add("hidden");
    }
  }

  el.queueList.addEventListener("click", async (e) => {
    const btn = e.target.closest(".q-btn");
    if (!btn) return;
    const row = btn.closest(".queue-row");
    if (!row) return;
    const act = btn.dataset.act;
    const jid = row.dataset.jid;
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/jobs/${jid}/${act}`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      await refreshQueue();
      if (act === "cancel" && state.currentJob === jid) {
        banner("Cancelling job…", "info");
      }
    } catch (err) {
      banner(`Queue action failed: ${err && err.message ? err.message : err}`);
      await refreshQueue();
    }
  });

  /* -------------------- global wiring -------------------- */
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawWave, 80);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkHealth();
  });
  setInterval(checkHealth, 15000);
  setInterval(refreshQueue, 2500);

  try {
    const saved = localStorage.getItem("ve.device");
    if (saved && ["auto", "cpu", "gpu"].includes(saved)) el.deviceSel.value = saved;
  } catch { /* ignore */ }

  checkHealth();
  drawWave();
})();
