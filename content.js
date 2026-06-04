/*
 * WinXP Visualizer for YouTube Music — content script
 * --------------------------------------------------
 * Overlays a canvas on YouTube Music's album-art elements and draws
 * Windows XP Media Player-style visualizations that change at random.
 *
 * Audio: tapped off the page's <video> element via the Web Audio API.
 *   IMPORTANT: we only re-route the audio through our graph once the
 *   AudioContext is actually running, so we never accidentally mute
 *   playback. If real audio data isn't available (e.g. a cross-origin
 *   stream returns zeros), we fall back to a synthetic signal so the
 *   visuals stay alive.
 */
(() => {
  'use strict';
  if (window.__WMPX_ACTIVE__) return;          // guard against double-injection
  window.__WMPX_ACTIVE__ = true;

  const api = globalThis.browser ?? globalThis.chrome;

  // ----------------------------------------------------------------- Settings
  const DEFAULTS = {
    enabled: true,
    intensity: 1.0,        // 0.4 .. 2.0  — multiplier on audio response
    opacity: 1.0,          // 0.3 .. 1.0  — 1 = fully replace art, lower = blend
    pinnedMode: 'random',  // 'random' or a specific mode key
    switchMin: 12,         // seconds — min time before a random switch
    switchMax: 30,         // seconds — max time before a random switch
    showName: true         // flash the visualization name on switch (WMP homage)
  };
  let settings = { ...DEFAULTS };

  function storageGet(defs) {
    // Works with both callback-style (chrome) and promise-style (firefox) APIs.
    return new Promise((res) => {
      try {
        const r = api.storage.local.get(defs, (v) => res(v || defs));
        if (r && typeof r.then === 'function') r.then((v) => res(v || defs), () => res(defs));
      } catch (e) { res(defs); }
    });
  }

  async function loadSettings() {
    const v = await storageGet(DEFAULTS);
    settings = { ...DEFAULTS, ...v };
    applyEnabled();
  }

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const k in changes) settings[k] = changes[k].newValue;
      applyEnabled();
      if ('pinnedMode' in changes) chooseMode(true);
      if ('nudge' in changes) chooseMode(true);   // "skip" button from popup
    });
  } catch (e) { /* storage may be unavailable in some contexts */ }

  // ------------------------------------------------------------------- Helpers
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function hsl(h, s, l, a) { return `hsla(${h},${s}%,${l}%,${a == null ? 1 : a})`; }

  function roundRectFill(ctx, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath(); ctx.fill();
  }

  // -------------------------------------------------------------- Audio engine
  let audioCtx = null, analyser = null, freqArr = null, waveArr = null;
  let hookedEl = null, liveZeroFrames = 0, useSynthetic = true;

  function getMedia() {
    return document.querySelector('video') || document.querySelector('audio');
  }

  function tryHookAudio() {
    if (!settings.enabled) return;
    const media = getMedia();
    if (!media) return;
    if (hookedEl === media && analyser) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return; }

    // Only attach once the context can run — otherwise routing the element
    // into a suspended graph would silence playback.
    if (audioCtx.state !== 'running') { audioCtx.resume && audioCtx.resume().catch(() => {}); return; }

    if (media.__wmpxHooked) { hookedEl = media; return; }
    try {
      const src = audioCtx.createMediaElementSource(media);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;
      src.connect(analyser);
      analyser.connect(audioCtx.destination);   // keep sound audible
      freqArr = new Uint8Array(analyser.frequencyBinCount);
      waveArr = new Uint8Array(analyser.fftSize);
      media.__wmpxHooked = true;
      hookedEl = media;
    } catch (e) {
      console.warn('[WMPX] audio hook unavailable, using synthetic visuals:', e && e.message);
      media.__wmpxHooked = true;   // don't retry forever on this element
      analyser = null;
    }
  }

  // Resume the context on the first user gesture (autoplay policy).
  const resume = () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume && audioCtx.resume().catch(() => {});
    tryHookAudio();
  };
  ['pointerdown', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, resume, { capture: true, passive: true }));
  document.addEventListener('play', resume, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audioCtx && audioCtx.state === 'suspended') audioCtx.resume && audioCtx.resume().catch(() => {});
  });

  // -------------------------------------------------- Analysis + synthetic data
  const analysis = {
    freq: null, wave: null, n: 0,
    level: 0, bass: 0, mid: 0, treble: 0,
    beat: false, t: 0, dt: 0.016, playing: false,
    energyAvg: 0, lastBeat: -1
  };

  const SYN_N = 1024;
  const synFreq = new Uint8Array(SYN_N);
  const synWave = new Uint8Array(2048);
  const syn = { t: 0, kickEnv: 0, nextKick: 0, drift: Math.random() * 1000 };

  function fillSynthetic(dt, playing) {
    syn.t += dt;
    const t = syn.t;
    syn.nextKick -= dt;
    if (syn.nextKick <= 0) { syn.kickEnv = 1; syn.nextKick = 0.42 + Math.random() * 0.34; }
    syn.kickEnv *= Math.pow(0.0009, dt);                 // quick decay
    const energy = playing ? 1 : 0.12;                   // calm down when paused
    for (let i = 0; i < SYN_N; i++) {
      const f = i / SYN_N;
      let v = (1 - f) * 0.55;
      v += 0.25 * Math.max(0, Math.sin(t * 1.3 + f * 8 + syn.drift)) * (1 - f);
      v += 0.18 * Math.max(0, Math.sin(t * 2.1 + f * 22)) * (0.4 + 0.6 * f);
      if (f < 0.12) v += syn.kickEnv * (1 - f / 0.12) * 0.9;
      if (f > 0.6) v += Math.random() * 0.12 * f;
      v *= energy;
      synFreq[i] = clamp(v * 255, 0, 255) | 0;
    }
    for (let i = 0; i < synWave.length; i++) {
      const x = i / synWave.length;
      let s = Math.sin(x * Math.PI * 4 + t * 3) * 0.40
            + Math.sin(x * Math.PI * 10 + t * 2.3) * 0.20
            + Math.sin(x * Math.PI * 18 + t * 5.0) * 0.12;
      s += syn.kickEnv * Math.sin(x * Math.PI * 2) * 0.5;
      s *= energy;
      synWave[i] = clamp(128 + s * 120, 0, 255) | 0;
    }
  }

  function updateAnalysis(ts) {
    const dt = analysis.t ? clamp((ts - analysis.t) / 1000, 0.001, 0.05) : 0.016;
    analysis.dt = dt; analysis.t = ts;

    const media = getMedia();
    analysis.playing = !!(media && !media.paused && !media.ended && media.readyState > 2);

    if (analyser) {
      analyser.getByteFrequencyData(freqArr);
      analyser.getByteTimeDomainData(waveArr);
      let sum = 0;
      for (let i = 0; i < freqArr.length; i++) sum += freqArr[i];
      if (sum > 0) liveZeroFrames = 0; else liveZeroFrames++;
    }
    useSynthetic = !analyser || liveZeroFrames > 20;

    if (useSynthetic) {
      fillSynthetic(dt, analysis.playing);
      analysis.freq = synFreq; analysis.wave = synWave; analysis.n = SYN_N;
    } else {
      analysis.freq = freqArr; analysis.wave = waveArr; analysis.n = freqArr.length;
    }

    const n = analysis.n, F = analysis.freq;
    const band = (a, b) => {
      let s = 0, c = 0;
      for (let i = Math.floor(a * n); i < Math.floor(b * n); i++) { s += F[i]; c++; }
      return c ? s / c / 255 : 0;
    };
    analysis.bass = band(0, 0.08);
    analysis.mid = band(0.08, 0.35);
    analysis.treble = band(0.35, 1.0);
    let s = 0; for (let i = 0; i < n; i++) s += F[i];
    analysis.level = s / n / 255;

    const I = clamp(settings.intensity, 0.2, 3);
    analysis.level *= I; analysis.bass *= I; analysis.mid *= I; analysis.treble *= I;

    analysis.energyAvg = analysis.energyAvg * 0.92 + analysis.level * 0.08;
    analysis.beat = (analysis.level > analysis.energyAvg * 1.32 &&
                     analysis.level > 0.05 &&
                     (ts - analysis.lastBeat) > 180);
    if (analysis.beat) analysis.lastBeat = ts;
  }

  // ------------------------------------------------------------ Visualizations
  // Each mode: { name, enter(state,w,h), frame(ctx,w,h,A,state) }. Sizes are in
  // CSS pixels (the context is pre-scaled by devicePixelRatio each frame).

  const bars = {
    name: 'Bars',
    enter(st) { st.peaks = null; st.hue = Math.random() * 360; },
    frame(ctx, w, h, A, st) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(2,4,12,0.55)'; ctx.fillRect(0, 0, w, h);
      const N = clamp(Math.round(w / 12), 16, 64) | 0;
      if (!st.peaks || st.peaks.length !== N) st.peaks = new Float32Array(N);
      const F = A.freq, n = A.n;
      const gap = 2, bw = (w - gap * (N + 1)) / N;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < N; i++) {
        const f0 = Math.pow(i / N, 1.6), f1 = Math.pow((i + 1) / N, 1.6);
        let lo = Math.floor(f0 * n * 0.8), hi = Math.max(Math.floor(f1 * n * 0.8), lo + 1);
        let s = 0, c = 0; for (let j = lo; j < hi; j++) { s += F[j]; c++; }
        let v = (c ? s / c : 0) / 255; v = Math.pow(v, 1.2);
        const bh = Math.min(h, v * h * 1.05);
        const x = gap + i * (bw + gap);
        const hue = (st.hue + i / N * 120) % 360;
        const g = ctx.createLinearGradient(0, h, 0, h - bh);
        g.addColorStop(0, hsl(hue, 100, 55, 0.95));
        g.addColorStop(1, hsl((hue + 60) % 360, 100, 65, 0.95));
        ctx.fillStyle = g;
        ctx.shadowColor = hsl(hue, 100, 60, 1); ctx.shadowBlur = 12;
        roundRectFill(ctx, x, h - bh, bw, bh, Math.min(bw / 2, 4));
        st.peaks[i] = Math.max(st.peaks[i] - A.dt * 0.6, bh / h);
        ctx.fillStyle = hsl((hue + 30) % 360, 100, 82, 0.95);
        ctx.fillRect(x, h - st.peaks[i] * h - 3, bw, 3);
      }
      ctx.shadowBlur = 0;
      st.hue = (st.hue + A.dt * 12) % 360;
    }
  };

  const waves = {
    name: 'Waves',
    enter(st) { st.hue = Math.random() * 360; },
    frame(ctx, w, h, A, st) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,2,10,0.18)'; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const W = A.wave, n = W.length, cy = h / 2;
      const copies = [{ o: 0, hue: st.hue }, { o: 6, hue: (st.hue + 120) % 360 }, { o: -6, hue: (st.hue + 240) % 360 }];
      for (const cp of copies) {
        ctx.beginPath();
        for (let i = 0; i <= w; i++) {
          const v = (W[Math.floor(i / w * (n - 1))] - 128) / 128;
          const y = cy + v * (h * 0.42) * (0.6 + A.level) + cp.o;
          if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i, y);
        }
        ctx.strokeStyle = hsl(cp.hue, 100, 62, 0.9);
        ctx.lineWidth = 2;
        ctx.shadowColor = hsl(cp.hue, 100, 60, 1); ctx.shadowBlur = 14;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      st.hue = (st.hue + A.dt * 30) % 360;
    }
  };

  const ambience = {
    name: 'Ambience',
    enter(st) { st.t = Math.random() * 100; st.hue = Math.random() * 360; },
    frame(ctx, w, h, A, st) {
      st.t += A.dt * (0.4 + A.level * 1.5);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const maxR = Math.max(w, h);
      for (let b = 0; b < 4; b++) {
        const ph = st.t * 0.6 + b * 1.7;
        const x = w * (0.5 + 0.36 * Math.sin(ph * 0.7 + b));
        const y = h * (0.5 + 0.36 * Math.cos(ph * 0.9 + b * 1.3));
        const rad = maxR * (0.22 + 0.12 * Math.sin(ph * 1.3)) * (0.7 + A.bass * 1.6 + A.level);
        const hue = (st.hue + b * 70 + st.t * 20) % 360;
        const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, rad));
        g.addColorStop(0, hsl(hue, 100, 60, 0.55));
        g.addColorStop(0.5, hsl((hue + 40) % 360, 100, 50, 0.18));
        g.addColorStop(1, hsl(hue, 100, 50, 0));
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      }
      st.hue = (st.hue + A.dt * 8) % 360;
    }
  };

  const spikes = {
    name: 'Spikes',
    enter(st) { st.rot = Math.random() * 6.28; st.hue = Math.random() * 360; },
    frame(ctx, w, h, A, st) {
      const beat = A.beat ? 1 : 0;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,1,8,0.35)'; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const cx = w / 2, cy = h / 2, m = Math.min(w, h);
      const R = m * 0.18 * (1 + A.bass * 0.6);
      const N = clamp(Math.round(m / 4), 36, 96) | 0;
      const F = A.freq, n = A.n;
      st.rot += A.dt * (0.2 + A.level * 0.8);
      for (let i = 0; i < N; i++) {
        const frac = i / N;
        const v = Math.pow(F[Math.floor(Math.pow(frac, 1.3) * n * 0.7)] / 255, 1.1);
        const len = R + v * m * 0.42;
        const hue = (st.hue + frac * 200) % 360;
        ctx.strokeStyle = hsl(hue, 100, 60, 0.9);
        ctx.lineWidth = 2.2; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 10;
        for (const dir of [1, -1]) {
          const a = st.rot + dir * frac * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
          ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 20; ctx.fillStyle = hsl(st.hue, 100, 72, 0.4 + 0.5 * A.bass);
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.5 * (1 + beat * 0.6), 0, 6.2832); ctx.fill();
      ctx.shadowBlur = 0;
      st.hue = (st.hue + A.dt * 16) % 360;
    }
  };

  const battery = {
    name: 'Battery',
    enter(st) { st.p = []; st.hue = Math.random() * 360; st.rot = 0; },
    frame(ctx, w, h, A, st) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,0,4,0.22)'; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const cx = w / 2, cy = h / 2, m = Math.min(w, h);
      st.rot += A.dt * (0.4 + A.level);
      const emit = (A.beat ? 14 : 0) + Math.floor(A.level * 6);
      for (let k = 0; k < emit && st.p.length < 400; k++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (40 + Math.random() * 160) * (0.5 + A.level);
        st.p.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, hue: (st.hue + Math.random() * 60) % 360 });
      }
      const rays = 10;
      for (let i = 0; i < rays; i++) {
        const a = st.rot + i / rays * Math.PI * 2;
        const len = m * 0.5 * (0.3 + A.mid + A.level * 0.5);
        ctx.strokeStyle = hsl((st.hue + i / rays * 180) % 360, 100, 60, 0.5);
        ctx.lineWidth = 2; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); ctx.stroke();
      }
      for (let i = st.p.length - 1; i >= 0; i--) {
        const p = st.p[i];
        p.x += p.vx * A.dt; p.y += p.vy * A.dt; p.vx *= 0.98; p.vy *= 0.98; p.life -= A.dt * 0.7;
        if (p.life <= 0) { st.p.splice(i, 1); continue; }
        ctx.fillStyle = hsl(p.hue, 100, 65, p.life);
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2 + 3 * p.life, 0, 6.2832); ctx.fill();
      }
      ctx.shadowBlur = 0;
      st.hue = (st.hue + A.dt * 20) % 360;
    }
  };

  const alchemy = {
    name: 'Alchemy',
    enter(st) {
      st.t = Math.random() * 100; st.hue = Math.random() * 360;
      st.a = 2 + Math.floor(Math.random() * 3); st.b = 3 + Math.floor(Math.random() * 3);
    },
    frame(ctx, w, h, A, st) {
      st.t += A.dt * (0.6 + A.level * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(1,0,6,0.14)'; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.4 * (0.6 + A.level * 0.8);
      const W = A.wave, n = W.length, steps = 180;
      const copies = [{ o: 0, h: st.hue }, { o: 0.6, h: (st.hue + 140) % 360 }];
      for (const cp of copies) {
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const u = i / steps * Math.PI * 2;
          const wv = (W[Math.floor(i / steps * (n - 1))] - 128) / 128;
          const r = R * (1 + wv * 0.25);
          const x = cx + Math.cos(st.a * u + st.t + cp.o) * r;
          const y = cy + Math.sin(st.b * u + st.t * 1.1) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = hsl(cp.h, 100, 62, 0.85);
        ctx.lineWidth = 1.6; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 16; ctx.stroke();
      }
      ctx.shadowBlur = 0;
      st.hue = (st.hue + A.dt * 18) % 360;
    }
  };

  const MODES = [bars, waves, ambience, spikes, battery, alchemy];
  const MODE_BY_KEY = {};
  MODES.forEach((m) => { MODE_BY_KEY[m.name.toLowerCase()] = m; });
  let currentMode = MODES[0];
  let switchAt = 0;

  const nameFlash = { text: '', until: 0 };
  function flashName(t) { nameFlash.text = '♪ ' + t; nameFlash.until = performance.now() + 1600; }
  function drawName(ctx, w, h, text, alpha) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.font = `${clamp(w / 22, 10, 20)}px "Trebuchet MS", Tahoma, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0,200,255,0.9)'; ctx.shadowBlur = 8;
    ctx.fillStyle = 'rgba(220,245,255,0.96)';
    ctx.fillText(text, 10, h - 8);
    ctx.restore();
  }

  function scheduleNextSwitch() {
    const lo = Math.max(4, settings.switchMin || 12);
    const hi = Math.max(lo + 1, settings.switchMax || 30);
    switchAt = performance.now() + (lo + Math.random() * (hi - lo)) * 1000;
  }

  function chooseMode(force) {
    let next;
    if (settings.pinnedMode && settings.pinnedMode !== 'random') {
      next = MODE_BY_KEY[settings.pinnedMode] || currentMode;
    } else {
      do { next = MODES[Math.floor(Math.random() * MODES.length)]; }
      while (next === currentMode && MODES.length > 1);
    }
    currentMode = next;
    scheduleNextSwitch();
    for (const e of overlays.values()) enterMode(e);
    if (settings.showName && force !== 'silent') flashName(currentMode.name);
  }

  // ----------------------------------------------------------- Overlay manager
  const overlays = new Map();   // container element -> { canvas, ctx, dpr, ro, prevPos, state }

  function artContainers() {
    const set = new Set();
    // Only the large now-playing art is a visualizer target. The bottom
    // player-bar thumbnail is intentionally left alone so it keeps the real
    // album art next to the song title.
    ['#song-image', 'ytmusic-player #song-image', '#player-page #song-image']
      .forEach((s) => document.querySelectorAll(s).forEach((el) => set.add(el)));
    return [...set].filter((el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 40 && r.height >= 40;
    });
  }

  function enterMode(entry) {
    entry.state = {};
    const w = entry.canvas.width / entry.dpr, h = entry.canvas.height / entry.dpr;
    if (currentMode.enter) currentMode.enter(entry.state, w, h);
    // Paint a solid background so the album art is fully covered right away.
    const ctx = entry.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#02040c';
    ctx.fillRect(0, 0, entry.canvas.width, entry.canvas.height);
  }

  function attach(container) {
    if (overlays.has(container)) return;
    container.querySelectorAll(':scope > .wmpx-canvas').forEach((n) => n.remove()); // clean strays
    const cs = getComputedStyle(container);
    const prevPos = container.style.position;
    if (cs.position === 'static') container.style.position = 'relative';

    const canvas = document.createElement('canvas');
    canvas.className = 'wmpx-canvas';
    Object.assign(canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      zIndex: '5', pointerEvents: 'none', display: 'block',
      borderRadius: cs.borderRadius || '0',
      opacity: String(clamp(settings.opacity, 0.15, 1))
    });
    container.appendChild(canvas);

    const entry = { canvas, ctx: canvas.getContext('2d'), dpr: 1, ro: null, prevPos, state: {} };
    const resize = () => {
      const r = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      entry.dpr = dpr;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      enterMode(entry);   // re-init so new size is reflected and bg repainted
    };
    resize();
    try { entry.ro = new ResizeObserver(resize); entry.ro.observe(container); } catch (e) {}
    overlays.set(container, entry);
  }

  function detach(container) {
    const e = overlays.get(container);
    if (!e) return;
    try { e.ro && e.ro.disconnect(); } catch (err) {}
    e.canvas.remove();
    container.style.position = e.prevPos || '';
    overlays.delete(container);
  }

  function syncOverlays() {
    if (!settings.enabled) { for (const c of [...overlays.keys()]) detach(c); return; }
    // Drop overlays whose container or canvas got torn out by YT Music's re-render.
    for (const [c, e] of [...overlays]) if (!c.isConnected || !e.canvas.isConnected) detach(c);
    const cur = artContainers(), curSet = new Set(cur);
    for (const c of cur) if (!overlays.has(c)) attach(c);
    for (const c of [...overlays.keys()]) if (!curSet.has(c)) detach(c);
  }

  function applyEnabled() {
    for (const e of overlays.values()) e.canvas.style.opacity = String(clamp(settings.opacity, 0.15, 1));
    syncOverlays();
  }

  // ------------------------------------------------------------------ Main loop
  function loop(ts) {
    requestAnimationFrame(loop);
    if (!settings.enabled) return;
    tryHookAudio();
    if (performance.now() >= switchAt) chooseMode(false);
    if (document.hidden) return;                 // pause drawing (audio keeps running)
    updateAnalysis(ts);
    for (const entry of overlays.values()) {
      const c = entry.canvas;
      if (!c.isConnected || c.width < 2 || c.height < 2) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 ||
          r.top > innerHeight || r.left > innerWidth) continue;   // off-screen / hidden
      const w = c.width / entry.dpr, h = c.height / entry.dpr, ctx = entry.ctx;
      ctx.setTransform(entry.dpr, 0, 0, entry.dpr, 0, 0);
      try { currentMode.frame(ctx, w, h, analysis, entry.state); } catch (e) {}
      if (nameFlash.until > ts) drawName(ctx, w, h, nameFlash.text, (nameFlash.until - ts) / 1200);
    }
  }

  // ----------------------------------------------------------------------- Init
  async function init() {
    await loadSettings();
    chooseMode('silent');

    syncOverlays();
    setInterval(syncOverlays, 1000);             // robust backstop for SPA re-renders

    let deb = 0;
    const mo = new MutationObserver(() => { clearTimeout(deb); deb = setTimeout(syncOverlays, 150); });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // New song -> pick a fresh random visualization.
    let lastTitle = document.title;
    setInterval(() => {
      if (document.title !== lastTitle) {
        lastTitle = document.title;
        if (settings.pinnedMode === 'random') chooseMode(true);
      }
    }, 700);

    requestAnimationFrame(loop);
  }

  init();
})();
