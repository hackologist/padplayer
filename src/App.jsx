import { useState, useRef, useEffect } from "react";
import { Play, Pause, Volume2, Coffee, Heart, Lock, Check, Mail, X, Sun } from "lucide-react";
import { createAudioEngine } from "./audioEngine";

// ─────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────
const KAIRO_URL = "https://kairoaudio.com";
const COFFEE_URL = "#"; // <- your Ko-fi / Stripe / BuyMeACoffee link
const STORAGE_KEY = "kairo_buyer_email";

const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const PREVIEW_SECONDS = 2;

const emptyKeyMap = () => KEYS.reduce((acc, k) => ((acc[k] = ""), acc), {});

// Build the 12 per-key URLs for a free pad hosted in /public/pads/<folder>/.
// "#" breaks URLs, so C# is stored on disk as "Csharp.mp3", etc.
//   padUrls("signature") -> { C: "/pads/signature/C.mp3", "C#": "/pads/signature/Csharp.mp3", ... }
const padUrls = (folder) =>
  KEYS.reduce((acc, k) => {
    acc[k] = `/pads/${folder}/${k.replace("#", "sharp")}.m4a`;
    return acc;
  }, {});

// Safe localStorage (wrapped so it can't crash; works once deployed).
const safeGet = (k) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch {} };
const safeDel = (k) => { try { window.localStorage.removeItem(k); } catch {} };

// Each texture has a URL per key (12 looping files).
// FREE: urls filled in directly, plays for everyone.
// PREMIUM: urls stay empty until a valid license unlocks them
//          (your serverless function returns the signed URLs).
const TEXTURES = [
  {
    id: "signature",
    name: "Signature",
    desc: "The classic Kairo pad",
    free: true,
    // 12 seamless-loop files live in /public/pads/signature/ (C.mp3 … B.mp3,
    // sharps as Csharp.mp3). Drop them in and every key plays — no other change.
    urls: padUrls("signature"),
  },
  {
    id: "ambient",
    name: "Ambient",
    desc: "Soft, airy, evolving",
    free: false,
    price: "$5 USD",
    previewUrl: "", // short clip for the 2s preview
    buyUrl: "#",    // Gumroad / Stripe checkout link
    urls: { ...emptyKeyMap() },
  },
  {
    id: "cinematic",
    name: "Cinematic",
    desc: "Wide, lush, emotive",
    free: false,
    price: "$5 USD",
    previewUrl: "",
    buyUrl: "#",
    urls: { ...emptyKeyMap() },
  },
  {
    id: "analog",
    name: "Warm Analog",
    desc: "Vintage, rich, full",
    free: false,
    price: "$5 USD",
    previewUrl: "",
    buyUrl: "#",
    urls: { ...emptyKeyMap() },
  },
];

// ─────────────────────────────────────────────────────────
// LICENSE VERIFICATION (stub)
// REAL DEPLOYMENT: replace the body with a call to your own
// serverless endpoint, e.g.:
//
//   const res = await fetch("/api/verify", {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ textureId, email }),
//   });
//   return await res.json();   // { ok, urls: { C: signedUrl, ... } }
//
// That endpoint calls Gumroad's license-verification API, confirms
// the key matches this product, then returns short-lived signed URLs
// for the 12 key files. Store the result so playback works in-page.
// ─────────────────────────────────────────────────────────
async function verifyLicense({ textureId, email }) {
  await new Promise((r) => setTimeout(r, 700)); // simulate network
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email || "").trim());
  if (!valid) throw new Error("Please enter a valid email address.");
  // Demo: any valid email unlocks. In production Gumroad decides this.
  return { ok: true, urls: { ...emptyKeyMap() } };
}

export default function App() {
  const [selectedId, setSelectedId] = useState("signature");
  const [activeKey, setActiveKey] = useState("C");
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [tone, setTone] = useState(0); // -1 dark .. 0 flat .. 1 bright
  const [previewing, setPreviewing] = useState(null);

  const [unlocked, setUnlocked] = useState({}); // { textureId: { C: url, ... } }
  const [modalPad, setModalPad] = useState(null);
  const [email, setEmail] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);

  // One Web Audio engine for the whole app (created once, lazily).
  const [engine] = useState(createAudioEngine);

  const previewTimer = useRef(null);
  const playingRef = useRef(false);

  useEffect(() => { playingRef.current = playing; }, [playing]);

  // Anton headline font is now self-hosted (see index.css @font-face),
  // so there's no Google Fonts CDN request on load.

  // Gumroad overlay — checkout pops up over the page, no redirect.
  // Loaded lazily on the visitor's first interaction so it never blocks
  // initial load or trips Safari's tracking-protection stall.
  useEffect(() => {
    const id = "gumroad-overlay";
    const events = ["pointerdown", "keydown", "touchstart", "scroll"];
    const remove = () => events.forEach((e) => window.removeEventListener(e, load));
    function load() {
      remove();
      if (document.getElementById(id)) return;
      const s = document.createElement("script");
      s.id = id;
      s.src = "https://gumroad.com/js/gumroad.js";
      s.async = true;
      document.body.appendChild(s);
    }
    events.forEach((e) => window.addEventListener(e, load, { once: true, passive: true }));
    return remove;
  }, []);

  useEffect(() => { engine.setVolume(volume); }, [engine, volume]);
  useEffect(() => { engine.setTone(tone); }, [engine, tone]);

  // On load: if we remembered the buyer's email, silently restore their
  // pads (re-verifies to fetch fresh signed URLs — no typing needed).
  useEffect(() => {
    const savedEmail = safeGet(STORAGE_KEY);
    if (!savedEmail) return;
    setEmail(savedEmail);
    setRestoring(true);
    (async () => {
      for (const pad of TEXTURES.filter((t) => !t.free)) {
        try {
          const { ok, urls } = await verifyLicense({ textureId: pad.id, email: savedEmail });
          if (ok) setUnlocked((prev) => ({ ...prev, [pad.id]: urls }));
        } catch { /* not purchased — skip */ }
      }
      setRestoring(false);
    })();
  }, []);

  const selectedTexture = TEXTURES.find((t) => t.id === selectedId);
  const isUnlocked = (t) => t.free || !!unlocked[t.id];

  function urlFor(texture, key) {
    if (texture.free) return texture.urls[key];
    return unlocked[texture.id]?.[key] || "";
  }
  const currentUrl = urlFor(selectedTexture, activeKey);
  const hasAudio = !!currentUrl;

  // When the pad or key changes mid-play, crossfade to it (no gap).
  useEffect(() => {
    if (!playingRef.current) return;
    const url = urlFor(selectedTexture, activeKey);
    if (!url) { engine.stop(); setPlaying(false); return; }
    engine.play(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, activeKey]);

  function togglePlay() {
    if (!currentUrl) return;
    engine.resume(); // unlock audio on this tap (mobile autoplay rules)
    if (playing) {
      engine.stop();
      setPlaying(false);
    } else {
      engine.play(currentUrl);
      setPlaying(true);
    }
  }

  function selectTexture(t) {
    if (!isUnlocked(t)) { openModal(t); return; }
    setSelectedId(t.id);
  }

  function togglePreview(pad) {
    clearTimeout(previewTimer.current);
    if (previewing === pad.id) { engine.stopPreview(); setPreviewing(null); return; }
    engine.resume();
    if (!pad.previewUrl) {
      // No preview clip yet — just show the "previewing" state for 2s.
      setPreviewing(pad.id);
      previewTimer.current = setTimeout(() => setPreviewing(null), PREVIEW_SECONDS * 1000);
      return;
    }
    engine.playPreview(pad.previewUrl);
    setPreviewing(pad.id);
    previewTimer.current = setTimeout(() => {
      engine.stopPreview();
      setPreviewing(null);
    }, PREVIEW_SECONDS * 1000);
  }

  function openModal(pad) { setModalPad(pad); setError(""); }

  async function handleUnlock() {
    if (!modalPad) return;
    setVerifying(true);
    setError("");
    try {
      const { urls } = await verifyLicense({ textureId: modalPad.id, email });
      setUnlocked((prev) => ({ ...prev, [modalPad.id]: urls }));
      safeSet(STORAGE_KEY, email.trim()); // remember on this device
      setSelectedId(modalPad.id);
      setModalPad(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setVerifying(false);
    }
  }

  function forget() {
    safeDel(STORAGE_KEY);
    setUnlocked({});
    setEmail("");
    setSelectedId("signature");
  }

  const anyOwned = TEXTURES.some((t) => !t.free && unlocked[t.id]);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 relative overflow-hidden">
      <div className="pointer-events-none absolute -top-40 -left-40 w-[40rem] h-[40rem] rounded-full bg-indigo-600/20 blur-[120px]" />
      <div className="pointer-events-none absolute top-1/3 -right-40 w-[36rem] h-[36rem] rounded-full bg-violet-700/20 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-0 left-1/4 w-[36rem] h-[36rem] rounded-full bg-sky-700/10 blur-[120px]" />

      <div className="relative max-w-3xl mx-auto px-6 py-12 sm:py-16">
        <header className="text-center mb-12">
          <svg
            width="76" height="76" viewBox="0 0 100 100"
            className="mx-auto mb-6"
            xmlns="http://www.w3.org/2000/svg"
            aria-label="Online Pad Player logo"
          >
            <defs>
              <linearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#818cf8" />
                <stop offset="1" stopColor="#7c3aed" />
              </linearGradient>
              <radialGradient id="brandHaze" cx="50%" cy="50%" r="50%">
                <stop offset="0" stopColor="#6366f1" stopOpacity="0.5" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="50" cy="50" r="48" fill="url(#brandHaze)" />
            <circle cx="50" cy="50" r="46" fill="none" stroke="url(#brandGrad)" strokeWidth="2" opacity="0.25" />
            <circle cx="50" cy="50" r="37" fill="none" stroke="url(#brandGrad)" strokeWidth="2.5" opacity="0.5" />
            <circle cx="50" cy="50" r="28" fill="none" stroke="url(#brandGrad)" strokeWidth="3" opacity="0.85" />
            <path d="M43 38 L65 50 L43 62 Z" fill="url(#brandGrad)" />
          </svg>
          <h1
            className="text-5xl sm:text-7xl uppercase leading-[0.95] tracking-tight"
            style={{ fontFamily: "'Anton', Impact, sans-serif" }}
          >
            Online Worship Pad Player
          </h1>
          <p className="mt-4 text-xs tracking-[0.3em] uppercase text-indigo-300/70">
            By{" "}
            <a href={KAIRO_URL} target="_blank" rel="noreferrer" className="hover:text-indigo-200 transition-colors underline-offset-4 hover:underline">
              Kairo Audio
            </a>
          </p>
        </header>

        {/* Player */}
        <section className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-6 sm:p-10 shadow-2xl">
          <div className="flex flex-col items-center mb-8">
            <button onClick={togglePlay} disabled={!hasAudio} className="relative group" aria-label={playing ? "Pause" : "Play"}>
              <span className={`absolute inset-0 rounded-full bg-indigo-500/30 blur-xl transition-all duration-1000 ${playing ? "scale-150 opacity-100 animate-pulse" : "scale-100 opacity-40"}`} />
              <span className="relative flex items-center justify-center w-24 h-24 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-900/50 group-hover:scale-105 group-active:scale-95 transition-transform disabled:opacity-40">
                {playing ? <Pause className="w-9 h-9" fill="white" /> : <Play className="w-9 h-9 ml-1" fill="white" />}
              </span>
            </button>
            <p className="mt-5 text-sm text-slate-400">
              {hasAudio ? (playing ? `Playing — ${selectedTexture.name}, Key of ${activeKey}` : `Ready — ${selectedTexture.name}, Key of ${activeKey}`) : `Add audio for key of ${activeKey}`}
            </p>
          </div>

          <div className="mb-8">
            <p className="text-xs uppercase tracking-widest text-slate-500 mb-3 text-center">Choose your key</p>
            <div className="grid grid-cols-6 gap-2">
              {KEYS.map((k) => (
                <button key={k} onClick={() => setActiveKey(k)}
                  className={`py-3 rounded-xl text-sm font-medium transition-all ${activeKey === k ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-900/40" : "bg-white/5 text-slate-300 hover:bg-white/10"}`}>
                  {k}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4 max-w-sm mx-auto">
            <div className="flex items-center gap-3">
              <Volume2 className="w-5 h-5 text-slate-400 shrink-0" aria-label="Volume" />
              <input type="range" min="0" max="1" step="0.01" value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="w-full accent-indigo-500" aria-label="Volume" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <Sun className="w-5 h-5 text-slate-400 shrink-0" aria-label="Tone" />
                <input type="range" min="-1" max="1" step="0.02" value={tone}
                  onChange={(e) => setTone(parseFloat(e.target.value))}
                  className="w-full accent-indigo-500" aria-label="Tone, darker to brighter" />
              </div>
              <div className="flex justify-between pl-8 mt-1 text-[10px] uppercase tracking-widest text-slate-500">
                <span>Darker</span>
                <button onClick={() => setTone(0)} className="hover:text-slate-300 transition-colors" aria-label="Reset tone to default">Default</button>
                <span>Brighter</span>
              </div>
            </div>
          </div>
        </section>

        {/* Now playing */}
        <section className="mt-8">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 flex items-center gap-4">
            <span className="relative shrink-0">
              <span className={`absolute inset-0 rounded-full bg-indigo-500/40 blur-md transition-all ${playing ? "scale-150 opacity-100 animate-pulse" : "opacity-0"}`} />
              <span className="relative flex items-center justify-center w-11 h-11 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 shadow-md">
                {playing ? <Pause className="w-4 h-4" fill="white" /> : <Play className="w-4 h-4 ml-0.5" fill="white" />}
              </span>
            </span>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-indigo-300/60">{playing ? "Now playing" : "Selected"}</p>
              <p className="font-medium leading-tight">{selectedTexture.name} — Key of {activeKey}</p>
            </div>
          </div>
        </section>

        {/* Textures */}
        <section className="mt-12">
          <h2 className="text-center text-2xl font-light mb-1">More textures</h2>
          <p className="text-center text-sm text-slate-400 mb-1">Unlock different pad sounds by Kairo Audio.</p>
          {restoring && <p className="text-center text-xs text-indigo-300/70 mb-5">Restoring your pads…</p>}
          {!restoring && <div className="mb-5" />}
          <div className="grid sm:grid-cols-3 gap-4">
            {TEXTURES.filter((t) => !t.free).map((pad) => {
              const isPreviewing = previewing === pad.id;
              const owned = isUnlocked(pad);
              const isSelected = selectedId === pad.id;
              return (
                <div key={pad.id}
                  className={`relative rounded-2xl border p-5 transition-all flex flex-col ${isSelected ? "border-indigo-400/60 bg-white/[0.06]" : "border-white/10 bg-white/[0.03] hover:border-indigo-400/40"}`}>
                  <div className="flex items-center gap-3 mb-3">
                    <button onClick={() => (owned ? selectTexture(pad) : togglePreview(pad))} aria-label={owned ? `Play ${pad.name}` : `Preview ${pad.name}`} className="relative shrink-0">
                      <span className={`absolute inset-0 rounded-full bg-indigo-500/40 blur-md transition-all ${isPreviewing ? "scale-150 opacity-100" : "opacity-0"}`} />
                      <span className="relative flex items-center justify-center w-11 h-11 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 shadow-md active:scale-95 transition-transform">
                        {isPreviewing ? <Pause className="w-4 h-4" fill="white" /> : <Play className="w-4 h-4 ml-0.5" fill="white" />}
                      </span>
                    </button>
                    <div className="min-w-0">
                      <p className="font-medium leading-tight flex items-center gap-1.5">
                        {pad.name}
                        {owned && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                      </p>
                      <p className="text-xs text-slate-400 truncate">{pad.desc}</p>
                    </div>
                  </div>

                  <p className="text-[11px] uppercase tracking-wider text-indigo-300/60 mb-3">
                    {owned ? (isSelected ? "Selected" : "Owned — tap to play") : isPreviewing ? "Previewing…" : `${PREVIEW_SECONDS}s preview`}
                  </p>

                  {owned ? (
                    <button onClick={() => selectTexture(pad)}
                      className="mt-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-white/10 text-sm font-medium hover:bg-white/20 transition-colors">
                      {isSelected ? "Playing in player" : "Play this pad"}
                    </button>
                  ) : (
                    <div className="mt-auto space-y-2">
                      <a href={pad.buyUrl} className="gumroad-button inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-white text-slate-900 text-sm font-semibold hover:bg-slate-100 transition-colors">
                        Buy {pad.price}
                      </a>
                      <button onClick={() => openModal(pad)}
                        className="inline-flex w-full items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors">
                        <Mail className="w-3 h-3" /> Already purchased? Unlock
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {anyOwned && (
            <p className="text-center mt-5 text-xs text-slate-500">
              Unlocked as {email}.{" "}
              <button onClick={forget} className="underline hover:text-slate-300">Not you?</button>
            </p>
          )}
        </section>

        {/* SEO / about — real readable content for search engines */}
        <section className="mt-14 max-w-2xl mx-auto text-center">
          <h2 className="text-lg font-light text-slate-300 mb-3">
            A free online worship pad player, in your browser
          </h2>
          <p className="text-sm leading-relaxed text-slate-500">
            Play sustained worship pads and drone pads in all 12 keys, anytime.
            This free worship pad player runs right in your browser, with no
            download and no sign up. Use the free pad for prayer, rehearsal,
            songwriting, or filling the space between songs, then unlock
            different worship and drone pad textures from Kairo Audio when you
            want more. Built for worship leaders and musicians who want an
            online pad player and drone pads ready in a single tap.
          </p>
        </section>

        {/* Donate */}
        <section className="mt-12 text-center">
          <div className="inline-flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.03] px-8 py-7">
            <Coffee className="w-7 h-7 text-amber-300/80 mb-3" />
            <h3 className="text-lg font-light mb-1">Enjoying the pads?</h3>
            <p className="text-sm text-slate-400 mb-5 max-w-xs">This player is free and always will be. Support helps keep it running.</p>
            <div className="flex flex-wrap justify-center gap-3">
              {["$3", "$5", "$10"].map((amt) => (
                <a key={amt} href={COFFEE_URL} target="_blank" rel="noreferrer"
                  className="px-5 py-2.5 rounded-full bg-amber-400/90 text-slate-900 text-sm font-semibold hover:bg-amber-300 transition-colors">{amt}</a>
              ))}
              <a href={COFFEE_URL} target="_blank" rel="noreferrer"
                className="px-5 py-2.5 rounded-full bg-white/10 text-sm font-medium hover:bg-white/20 transition-colors inline-flex items-center gap-1.5">
                <Heart className="w-3.5 h-3.5" /> Custom
              </a>
            </div>
          </div>
        </section>

        <footer className="mt-14 pt-8 border-t border-white/5 text-center text-sm text-slate-500">
          Powered by{" "}
          <a href={KAIRO_URL} target="_blank" rel="noreferrer" className="hover:text-slate-300 transition-colors">kairoaudio.com</a>
        </footer>
      </div>

      {/* Unlock modal */}
      {modalPad && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-sm" onClick={() => setModalPad(null)}>
          <div className="relative max-w-sm w-full rounded-3xl border border-white/10 bg-slate-900 p-8" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setModalPad(null)} className="absolute top-4 right-4 text-slate-500 hover:text-slate-300"><X className="w-5 h-5" /></button>
            <div className="mx-auto w-12 h-12 rounded-full bg-indigo-500/20 flex items-center justify-center mb-4"><Lock className="w-5 h-5 text-indigo-300" /></div>
            <h3 className="text-xl font-light text-center mb-1">Unlock {modalPad.name}</h3>
            <p className="text-sm text-slate-400 text-center mb-6">Enter the email you purchased with. It unlocks here instantly.</p>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com"
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm outline-none focus:border-indigo-400/60 mb-3" />
            {error && <p className="text-xs text-rose-400 mb-3">{error}</p>}
            <button onClick={handleUnlock} disabled={verifying}
              className="w-full px-6 py-3 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
              {verifying ? "Verifying…" : "Unlock"}
            </button>
            <a href={modalPad.buyUrl} className="gumroad-button block text-center mt-4 text-sm text-slate-400 hover:text-slate-200 transition-colors">
              Don't have it yet? Buy for {modalPad.price}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
