import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // True only on the PRODUCTION deploy (the live site). On preview/staging
    // and local dev it's false, so the not-yet-launched paid pads + tip jar
    // stay fully functional there for building/testing, but render a greyed
    // "Coming soon" on the live site. Vercel sets VERCEL_ENV during the build.
    __COMING_SOON__: JSON.stringify(process.env.VERCEL_ENV === "production"),
  },
  build: {
    // Compile JS down so older mobile browsers (older iOS Safari/Chrome)
    // can run it. Without this, modern syntax (e.g. ??=) crashes old
    // Safari and the page renders blank/white.
    target: ["es2015", "safari11"],
  },
})
