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

export function createAudioEngine() {
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
