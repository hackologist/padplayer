// ─────────────────────────────────────────────────────────
// Web Audio engine for the pad player.
//
// Why Web Audio (not <audio>.volume)? iOS Safari IGNORES
// HTMLMediaElement.volume from JS, so plain element fades do
// nothing on iPhone/iPad. Routing every element through a
// GainNode gives real, sample-accurate fades on ALL devices.
//
// It provides:
//   • True CROSSFADE when switching pad/key — two "voices"
//     (A/B), the new one ramps up while the old ramps down,
//     overlapping so there's never a gap of silence.
//   • Seamless infinite loop via native loop=true (files are
//     already crafted as seamless loops, so no manual splice).
//   • A one-knob TONE control (high-shelf): darker ↔ brighter.
//   • A separate preview voice that doesn't disturb playback.
// ─────────────────────────────────────────────────────────

const CF_MS = 600;        // crossfade time when switching pad/key
const VOL_RAMP_MS = 120;  // smoothing so the volume slider doesn't zipper
const TONE_RAMP_MS = 120;

// Tone maps a -1..1 knob linearly to a high-shelf gain in dB. The whole range
// sits well below the unfiltered original (0 dB): full-left is very dark,
// full-right lifts back up but never reaches the raw file, and the default
// (knob centered, a=0) sits halfway between the two extremes.
const TONE_FREQ = 3200;   // shelf corner; above this = "air"/brightness
const TONE_DARK_DB = -32; // a=-1, "Darker"
const TONE_BRIGHT_DB = -3; // a=+1, "Brighter" (still cut — never the original)

const AC =
  typeof window !== "undefined"
    ? window.AudioContext || window.webkitAudioContext
    : null;

export function createAudioEngine() {
  let ctx = null;
  let master = null;     // overall volume
  let tone = null;       // high-shelf tone filter (master -> tone -> destination)
  let voices = [];       // [{ el, src, gain }] — two for crossfading
  let preview = null;    // { el, src, gain } — independent preview bus
  let active = 0;        // index of the voice currently in front
  let volume = 0.8;
  let toneAmount = 0;    // -1 (dark) .. 0 (flat) .. 1 (bright)
  let started = false;
  let ok = !!AC;         // false only on truly ancient browsers

  function newEl() {
    const el = new Audio();
    el.preload = "none";          // don't fetch audio bytes until played
    el.crossOrigin = "anonymous"; // lets Web Audio read CORS-enabled (paid) URLs
    el.loop = true;
    return el;
  }

  function makeVoice() {
    const el = newEl();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    let src = null;
    try {
      src = ctx.createMediaElementSource(el);
      src.connect(gain);
      gain.connect(master);
    } catch {
      ok = false;
    }
    return { el, src, gain };
  }

  function start() {
    if (started || !ok) return;
    try {
      ctx = new AC();
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
      started = true;
    } catch {
      ok = false;
    }
  }

  function toneToDb(amt) {
    const a = Math.max(-1, Math.min(1, amt));
    // Linear: a=-1 → -32, a=+1 → -3, a=0 → midpoint (-17.5).
    return TONE_DARK_DB + ((a + 1) / 2) * (TONE_BRIGHT_DB - TONE_DARK_DB);
  }

  // Smoothly move an AudioParam to `to` over `ms`, interrupting any
  // ramp already in flight (so rapid key changes stay glitch-free).
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

  function resume() {
    start();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  function load(voice, url) {
    // Avoid reloading the same file (keeps the loop uninterrupted).
    if (voice.el.currentSrc && voice.el.currentSrc.indexOf(url) !== -1) return;
    if (voice.el.getAttribute("src") === url) return;
    voice.el.src = url;
  }

  return {
    get ok() { return ok; },

    // Call inside a user gesture (tap) to satisfy mobile autoplay rules.
    resume,

    setVolume(v) {
      volume = v;
      start();
      if (master) ramp(master.gain, v, VOL_RAMP_MS);
    },

    // amount: -1 (darkest) .. 0 (flat) .. 1 (brightest)
    setTone(amount) {
      toneAmount = Math.max(-1, Math.min(1, amount));
      start();
      if (tone) ramp(tone.gain, toneToDb(toneAmount), TONE_RAMP_MS);
    },

    // Crossfade the main bus to `url`, looping. Restarts from 0.
    play(url, { fade = CF_MS } = {}) {
      if (!url) return;
      resume();
      if (!started) return;
      const cur = voices[active];
      const idle = voices[1 - active];
      load(idle, url);
      idle.el.loop = true;
      try { idle.el.currentTime = 0; } catch { /* ignore */ }
      const p = idle.el.play();
      if (p && p.catch) p.catch(() => {});
      ramp(idle.gain.gain, 1, fade);
      ramp(cur.gain.gain, 0, fade);
      const stale = cur.el;
      setTimeout(() => { try { stale.pause(); } catch { /* ignore */ } }, fade + 40);
      active = 1 - active;
    },

    // Fade out + pause the main bus.
    stop({ fade = CF_MS } = {}) {
      if (!started) return;
      const cur = voices[active];
      ramp(cur.gain.gain, 0, fade);
      const stale = cur.el;
      setTimeout(() => { try { stale.pause(); } catch { /* ignore */ } }, fade + 40);
    },

    playPreview(url, { fade = 300 } = {}) {
      if (!url) return;
      resume();
      if (!started || !preview) return;
      load(preview, url);
      preview.el.loop = true;
      try { preview.el.currentTime = 0; } catch { /* ignore */ }
      const p = preview.el.play();
      if (p && p.catch) p.catch(() => {});
      ramp(preview.gain.gain, 1, fade);
    },

    stopPreview({ fade = 300 } = {}) {
      if (!started || !preview) return;
      ramp(preview.gain.gain, 0, fade);
      const el = preview.el;
      setTimeout(() => { try { el.pause(); } catch { /* ignore */ } }, fade + 40);
    },
  };
}
