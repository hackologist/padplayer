// ─────────────────────────────────────────────────────────
// Web Audio engine for the pad player.
//
// Goals (and the platform realities behind them):
//
//  • Real fades / crossfade / tone EQ on ALL devices. iOS Safari ignores
//    HTMLMediaElement.volume from JS, so we route every foreground element
//    through a GainNode + BiquadFilter in an AudioContext.
//
//  • Keep playing when the screen LOCKS. iOS suspends the AudioContext when
//    the page is backgrounded (webkit.org/show_bug.cgi?id=237878), which would
//    stop all Web Audio. A plain <audio> element, however, keeps playing while
//    locked. So we keep a NON-routed "background" element and hand playback to
//    it when the page hides, then hand back to the filtered voices on return.
//    If the handoff can't start (older iOS), we simply degrade to the previous
//    behaviour — never worse.
//
//  • navigator.audioSession = "playback" tells iOS this is media playback:
//    it ignores the silent/ringer switch (a common "no sound" cause) and, on
//    modern iOS, can keep the AudioContext itself alive while locked.
//
// Architecture:
//   foreground:  2 routed voices (A/B) -> gain -> master -> tone -> output
//                + 1 routed preview voice
//   background:  1 plain <audio> element, NOT routed (survives screen lock)
// ─────────────────────────────────────────────────────────

const CF_MS = 600;        // crossfade time when switching pad/key
const VOL_RAMP_MS = 120;  // smoothing so the volume slider doesn't zipper
const TONE_RAMP_MS = 120;
const HANDOFF_MS = 350;   // fade when handing audio back from background

// Tone maps a -1..1 knob linearly to a high-shelf gain in dB. The whole range
// sits well below the unfiltered original (0 dB); the default (a=0) is halfway.
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
  let bg = null;         // plain <audio>, NOT routed — plays while screen locked
  let active = 0;        // index of the routed voice in front
  let volume = 0.8;
  let toneAmount = 0;
  let started = false;
  let ok = !!AC;
  let playing = false;   // intent to play (independent of fg/bg path)
  let currentUrl = "";
  let hidden = false;    // page is currently backgrounded / screen locked
  let onBg = false;      // background element is currently carrying audio

  function newEl() {
    const el = new Audio();
    el.preload = "none";
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
      bg = newEl();           // not routed -> keeps playing when ctx is suspended
      bg.muted = true;
      // Treat as media: ignore the silent switch + allow background playback.
      try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* not supported */ }
      // If iOS interrupts the context while we're in the foreground, recover.
      ctx.onstatechange = () => {
        if (playing && !hidden && ctx.state !== "running") ctx.resume().catch(() => {});
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

  function load(el, url) {
    if (el.getAttribute("src") === url) return;
    el.src = url;
  }

  function safePlay(el) {
    try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
  }

  // Crossfade a routed voice up to `url` and the old one down.
  function crossfadeTo(url) {
    const cur = voices[active];
    const idle = voices[1 - active];
    load(idle.el, url);
    idle.el.loop = true;
    try { idle.el.currentTime = 0; } catch { /* ignore */ }
    safePlay(idle.el);
    ramp(idle.gain.gain, 1, CF_MS);
    ramp(cur.gain.gain, 0, CF_MS);
    const stale = cur.el;
    setTimeout(() => { try { stale.pause(); } catch { /* ignore */ } }, CF_MS + 40);
    active = 1 - active;
  }

  // Prime the background element (muted) inside the play() gesture so iOS will
  // let us re-play it later, when the screen locks, without a fresh tap.
  function primeBg(url) {
    if (!bg) return;
    load(bg, url);
    bg.loop = true;
    bg.muted = true;
    try {
      const p = bg.play();
      if (p && p.then) p.then(() => { if (!onBg) { try { bg.pause(); } catch { /* ignore */ } } }).catch(() => {});
    } catch { /* ignore */ }
  }

  return {
    get ok() { return ok; },
    isPlaying() { return playing; },

    // Call inside a user gesture (tap) to satisfy mobile autoplay rules.
    resume() { start(); resumeCtx(); },

    setVolume(v) {
      volume = v;
      start();
      if (master) ramp(master.gain, v, VOL_RAMP_MS);
      if (bg) { try { bg.volume = v; } catch { /* ignore (iOS) */ } }
    },

    // amount: -1 (darkest) .. 0 (default) .. +1 (brightest, still cut)
    setTone(amount) {
      toneAmount = Math.max(-1, Math.min(1, amount));
      start();
      if (tone) ramp(tone.gain, toneToDb(toneAmount), TONE_RAMP_MS);
    },

    // Start (or crossfade to) a looping pad.
    play(url) {
      if (!url) return;
      start();
      if (!started) return; // no Web Audio support — nothing we can drive
      resumeCtx();
      currentUrl = url;
      playing = true;
      if (hidden) {
        // Started/changed while backgrounded — drive the plain bg element.
        load(bg, url);
        bg.loop = true;
        bg.muted = false;
        try { bg.volume = volume; } catch { /* ignore */ }
        try { bg.currentTime = 0; } catch { /* ignore */ }
        safePlay(bg);
        onBg = true;
        return;
      }
      onBg = false;
      crossfadeTo(url);
      primeBg(url);
    },

    stop() {
      playing = false;
      onBg = false;
      if (bg) { try { bg.pause(); } catch { /* ignore */ } }
      if (!started) return;
      const cur = voices[active];
      ramp(cur.gain.gain, 0, CF_MS);
      const stale = cur.el;
      setTimeout(() => { try { stale.pause(); } catch { /* ignore */ } }, CF_MS + 40);
    },

    // Page hidden / screen locked: hand audio to the plain bg element, which
    // keeps playing even when iOS suspends the AudioContext.
    onHidden() {
      hidden = true;
      if (!started || !playing) return;
      let t = 0;
      try { t = voices[active].el.currentTime || 0; } catch { /* ignore */ }
      try {
        load(bg, currentUrl);
        bg.loop = true;
        bg.muted = false;
        try { bg.volume = volume; } catch { /* ignore */ }
        try { if (t) bg.currentTime = t; } catch { /* ignore */ }
        safePlay(bg);
        onBg = true;
      } catch { /* ignore */ }
      // Pause routed voices — they're silenced by suspension anyway, and this
      // prevents a double-play on platforms that DON'T suspend.
      voices.forEach((x) => { try { x.el.pause(); } catch { /* ignore */ } });
    },

    // Page visible again: resume the context and hand back to filtered playback.
    onVisible() {
      hidden = false;
      if (!started) return;
      resumeCtx();
      if (!playing) { if (bg) { try { bg.pause(); } catch { /* ignore */ } } return; }
      let t = 0;
      try { t = onBg ? (bg.currentTime || 0) : (voices[active].el.currentTime || 0); } catch { /* ignore */ }
      const v = voices[active];
      load(v.el, currentUrl);
      v.el.loop = true;
      try { if (t) v.el.currentTime = t; } catch { /* ignore */ }
      safePlay(v.el);
      ramp(v.gain.gain, 1, HANDOFF_MS);
      if (bg && onBg) {
        const b = bg;
        setTimeout(() => { try { b.pause(); b.muted = true; } catch { /* ignore */ } }, HANDOFF_MS);
      }
      onBg = false;
    },

    playPreview(url) {
      if (!url) return;
      start();
      resumeCtx();
      if (!preview) return;
      load(preview.el, url);
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
