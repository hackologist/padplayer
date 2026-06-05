// ─────────────────────────────────────────────────────────
// Web Audio engine for the pad player.
//
// Why Web Audio (not <audio>.volume)? iOS Safari IGNORES
// HTMLMediaElement.volume from JS, so plain element fades do nothing on
// iPhone. Routing every element through a GainNode + BiquadFilter gives real,
// sample-accurate fades, a crossfade between keys, and the tone EQ on ALL
// devices.
//
// Playback paths:
//   • 2 routed voices (A/B) for gapless CROSSFADE when switching pad/key.
//   • 1 routed preview voice for the short paid-pad previews.
//
// iOS notes:
//   • navigator.audioSession = "playback" → treat as media so audio ignores
//     the silent/ringer switch (a common "no sound" cause).
//   • iOS suspends the AudioContext when the screen locks, which pauses audio.
//     We do NOT fight that (a second background element caused bandwidth
//     stutter and didn't work reliably). Instead, on return we RESUME from the
//     exact position — never restart, never need a refresh.
// ─────────────────────────────────────────────────────────

const FILE_RATE = 44100;  // sample rate of the pad files (pin the context to it)
const CF_MS = 600;        // crossfade time when switching pad/key
const VOL_RAMP_MS = 120;  // smoothing so the volume slider doesn't zipper
const TONE_RAMP_MS = 120;
const RESUME_MS = 250;    // fade back in when returning to the tab

// Tone maps a -1..1 knob linearly to a high-shelf gain in dB. The whole range
// sits below the unfiltered original (0 dB); the default (a=0) is the midpoint.
const TONE_FREQ = 3200;
const TONE_DARK_DB = -32;  // a=-1, "Darker"
const TONE_BRIGHT_DB = -3; // a=+1, "Brighter" (still cut — never the original)

const AC =
  typeof window !== "undefined"
    ? window.AudioContext || window.webkitAudioContext
    : null;

function toneToDb(amt) {
  const a = Math.max(-1, Math.min(1, amt));
  return TONE_DARK_DB + ((a + 1) / 2) * (TONE_BRIGHT_DB - TONE_DARK_DB);
}

// Plain-audio engine: bare <audio> element(s), NO Web Audio for the CURRENT pad.
// A plain element plays at native rate (no MediaElementSource clock resync = no
// transpose) and keeps playing when the screen locks (background).
//
// Optional fade-out crossfade (opts.fadeOut): on a key change, the NEW pad
// starts immediately on a fresh plain element (still background-safe, no
// transpose), while the OLD element is routed through a SHORT-LIVED Web Audio
// gain and faded out over ~fadeMs, then discarded. Web Audio touches only the
// throwaway old element for a few seconds (screen on, user just tapped), so it
// can never transpose or affect background. iOS can't fade a plain element's
// volume, so the new pad can't fade *in* — it enters at full as the old recedes.
function createPlainEngine(opts = {}) {
  const AC = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
  const FADE_MS = opts.fadeOut ? (opts.fadeMs || 4000) : 0;
  let ctx = null;
  let cur = null;        // current plain <audio> element
  let curUrl = "";
  let playing = false;
  let volume = 1;        // full volume (no in-app volume control; device handles it)

  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* unsupported */ }

  function newEl(url) {
    const el = new Audio();
    el.preload = "auto"; el.loop = true; el.setAttribute("playsinline", "");
    el.src = url; try { el.volume = volume; } catch { /* iOS */ }
    return el;
  }
  function safePlay(el) { try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ } }
  function ensureCtx() {
    if (!ctx && AC && FADE_MS) { try { ctx = new AC(); } catch { /* ignore */ } }
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  }
  function fadeOutDiscard(el) {
    if (!ctx) { try { el.pause(); } catch { /* ignore */ } return; }
    try {
      const s = ctx.createMediaElementSource(el);
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(volume || 1, t);
      g.gain.linearRampToValueAtTime(0.0001, t + FADE_MS / 1000);
      s.connect(g); g.connect(ctx.destination);
      setTimeout(() => { try { el.pause(); s.disconnect(); g.disconnect(); } catch { /* ignore */ } }, FADE_MS + 200);
    } catch { try { el.pause(); } catch { /* ignore */ } }
  }

  return {
    get ok() { return true; },
    isPlaying() { return playing; },
    getDebug() { return { rate: 0, state: cur && !cur.paused ? ("playing(plain" + (FADE_MS ? "+fade" : "") + ")") : "paused", ct: cur ? cur.currentTime || 0 : 0, pr: cur ? cur.playbackRate : 0, src: cur ? (cur.getAttribute("src") || "").split("/").pop() : "—" }; },
    resume() { try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* ignore */ } ensureCtx(); },
    setVolume(v) { volume = v; if (cur) { try { cur.volume = v; } catch { /* iOS */ } } },
    setTone() { /* tone is baked into the files */ },
    play(url) {
      if (!url) return;
      playing = true;
      ensureCtx();
      if (cur && curUrl === url && cur.getAttribute("src") === url) { safePlay(cur); return; } // resume same pad
      const old = cur;
      cur = newEl(url); curUrl = url;
      safePlay(cur);
      if (old) { if (FADE_MS) fadeOutDiscard(old); else { try { old.pause(); } catch { /* ignore */ } } }
    },
    stop() { playing = false; if (cur) { try { cur.pause(); } catch { /* ignore */ } } },
    onVisible() { if (playing && cur) safePlay(cur); },
    playPreview() {},
    stopPreview() {},
  };
}

export function createAudioEngine(opts = {}) {
  if (opts.plain) return createPlainEngine(opts);
  let ctx = null;
  let master = null;     // overall volume
  let tone = null;       // high-shelf tone filter
  let voices = [];       // [{ el, gain }] — two routed voices for crossfading
  let preview = null;    // { el, gain } — routed preview bus
  let active = 0;        // index of the routed voice in front
  let volume = 0.8;
  let toneAmount = 0;
  let started = false;
  let ok = !!AC;
  let playing = false;   // intent to play
  let currentUrl = "";

  function newEl() {
    const el = new Audio();
    // "auto" = buffer the whole pad once it has a src (only set on play), so
    // playback feeds Web Audio from a full buffer instead of trickling chunks
    // over the network mid-stream (which pulses/stutters). No src on page load,
    // so this never affects initial page speed.
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.loop = true;
    el.setAttribute("playsinline", "");
    return el;
  }

  function makeVoice() {
    const el = newEl();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(gain);
      gain.connect(master);
    } catch {
      ok = false;
    }
    return { el, gain };
  }

  function start() {
    if (started || !ok) return;
    try {
      // iOS Safari stutters, distorts, and pitch-drifts (a slow speed-up then
      // resync, ~once a minute) when the AudioContext sample rate doesn't match
      // the audio it's routing — a documented WebKit bug. Our pads are 44.1kHz,
      // so pin the context to 44100 to keep MediaElementSource in sync.
      try { ctx = new AC({ sampleRate: FILE_RATE }); } catch { ctx = new AC(); }
      master = ctx.createGain();
      master.gain.value = volume;
      tone = ctx.createBiquadFilter();
      tone.type = "highshelf";
      tone.frequency.value = TONE_FREQ;
      tone.gain.value = toneToDb(toneAmount);
      master.connect(tone);
      tone.connect(ctx.destination);
      voices = [makeVoice(), makeVoice()];
      preview = makeVoice();
      // Treat as media: ignore the silent switch.
      try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* unsupported */ }
      // iOS sporadically "interrupts" the AudioContext (screen off, a
      // notification, another app's audio). The media element MUST be paused
      // during the interruption — otherwise it keeps advancing while the
      // context is frozen, then "catches up" by briefly playing fast when the
      // context resumes, which is heard as the pad jumping up a key for a few
      // seconds before resyncing. Pausing freezes its position so resume is
      // clean and in-sync.
      ctx.onstatechange = () => {
        if (ctx.state === "running") {
          if (playing) safePlay(voices[active].el);
        } else {
          voices.forEach((v) => { try { v.el.pause(); } catch { /* ignore */ } });
          if (playing) ctx.resume().catch(() => {});
        }
      };
      started = true;
    } catch {
      ok = false;
    }
  }

  function ramp(param, to, ms) {
    const now = ctx.currentTime;
    try {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(to, now + ms / 1000);
    } catch {
      try { param.value = to; } catch { /* ignore */ }
    }
  }

  function resumeCtx() {
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  }

  function safePlay(el) {
    try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
  }

  return {
    get ok() { return ok; },
    isPlaying() { return playing; },

    // Live diagnostics for the ?debug overlay.
    getDebug() {
      const el = started && voices[active] ? voices[active].el : null;
      return {
        rate: ctx ? ctx.sampleRate : 0,
        state: ctx ? ctx.state : "—",
        ct: el ? el.currentTime : 0,
        pr: el ? el.playbackRate : 0,
        src: el ? (el.getAttribute("src") || "").split("/").pop() : "—",
      };
    },

    // Call inside a user gesture (tap) to satisfy mobile autoplay rules.
    resume() { start(); resumeCtx(); },

    setVolume(v) {
      volume = v;
      start();
      if (master) ramp(master.gain, v, VOL_RAMP_MS);
    },

    // amount: -1 (darkest) .. 0 (default) .. +1 (brightest, still cut)
    setTone(amount) {
      toneAmount = Math.max(-1, Math.min(1, amount));
      start();
      if (tone) ramp(tone.gain, toneToDb(toneAmount), TONE_RAMP_MS);
    },

    // Start playback, resume the same pad from its position, or crossfade to a
    // new pad/key. Pressing play after pause resumes — it never restarts.
    play(url) {
      if (!url) return;
      start();
      if (!started) return;
      resumeCtx();
      playing = true;
      const cur = voices[active];
      if (url === currentUrl && cur.el.getAttribute("src") === url) {
        // Same pad that was paused — resume from where it stopped.
        safePlay(cur.el);
        ramp(cur.gain.gain, 1, RESUME_MS);
        return;
      }
      // New pad/key — crossfade the idle voice up from the start.
      currentUrl = url;
      const idle = voices[1 - active];
      if (idle.el.getAttribute("src") !== url) idle.el.src = url;
      idle.el.loop = true;
      try { idle.el.currentTime = 0; } catch { /* ignore */ }
      safePlay(idle.el);
      ramp(idle.gain.gain, 1, CF_MS);
      ramp(cur.gain.gain, 0, CF_MS);
      const stale = cur.el;
      setTimeout(() => { try { stale.pause(); } catch { /* ignore */ } }, CF_MS + 40);
      active = 1 - active;
    },

    // Pause: fade out and pause, but KEEP the position so play() resumes it.
    stop() {
      playing = false;
      if (!started) return;
      const cur = voices[active];
      ramp(cur.gain.gain, 0, CF_MS);
      const stale = cur.el;
      setTimeout(() => { try { stale.pause(); } catch { /* ignore */ } }, CF_MS + 40);
    },

    // Returning to the tab (iOS may have suspended the context on lock):
    // resume the context and continue the same pad from its position.
    onVisible() {
      if (!started) return;
      resumeCtx(); // if the context was interrupted, onstatechange replays cleanly
      if (playing && ctx.state === "running") safePlay(voices[active].el);
    },

    playPreview(url) {
      if (!url) return;
      start();
      if (!started || !preview) return;
      resumeCtx();
      if (preview.el.getAttribute("src") !== url) preview.el.src = url;
      preview.el.loop = true;
      try { preview.el.currentTime = 0; } catch { /* ignore */ }
      safePlay(preview.el);
      ramp(preview.gain.gain, 1, 300);
    },

    stopPreview() {
      if (!preview) return;
      ramp(preview.gain.gain, 0, 300);
      const el = preview.el;
      setTimeout(() => { try { el.pause(); } catch { /* ignore */ } }, 340);
    },
  };
}
