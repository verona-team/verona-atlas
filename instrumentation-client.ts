// Client-side instrumentation. Runs after the HTML doc is loaded but before
// React hydration, which is the recommended place to initialize analytics
// SDKs in Next.js 15.3+ / 16.
//
// Docs: https://posthog.com/docs/libraries/next-js

import posthog from "posthog-js";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: "/ingest",
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    // Opts into PostHog's recommended modern config bundle: autocapture,
    // session recording, exception capture, web vitals, and history-change
    // pageviews (so app-router navigations are tracked automatically). Pinning
    // the date prevents future SDK updates from silently changing behavior.
    defaults: "2026-01-30",
    capture_exceptions: true,
    loaded: (ph) => {
      if (process.env.NODE_ENV === "development") {
        ph.debug();
      }
    },
  });
} else if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  console.warn(
    "[posthog] NEXT_PUBLIC_POSTHOG_KEY is not set; analytics + session replay are disabled."
  );
}
