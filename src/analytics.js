// PostHog product analytics — lazy-loaded so it never blocks the fast first
// paint. We dynamic-import the library on idle (after the app is interactive),
// and any track() called before it finishes loading is queued.
const POSTHOG_KEY = "phc_CEyQZMWVx4opgZBZpmD3gQXVUUDsDfvpPP3nNkTgzKZw";
const POSTHOG_HOST = "https://us.i.posthog.com";

let ph = null;
let loading = null;
const queue = [];

export function initAnalytics() {
  if (loading || ph) return loading;
  loading = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        defaults: "2026-05-30",          // PostHog's recommended modern defaults
        person_profiles: "identified_only",
        capture_pageview: true,
        capture_pageleave: true,         // needed for time-on-page
      });
      ph = posthog;
      // flush anything captured before load finished
      while (queue.length) {
        const [event, props] = queue.shift();
        ph.capture(event, props);
      }
      return posthog;
    })
    .catch(() => { /* analytics is best-effort; never break the app */ });
  return loading;
}

// Fire a custom event (pad_play, buy_click, unlock_success, scroll_depth, …).
export function track(event, props) {
  if (ph) { ph.capture(event, props); return; }
  queue.push([event, props]);
  initAnalytics();
}
