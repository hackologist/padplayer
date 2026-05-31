import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Compile JS down so older mobile browsers (older iOS Safari/Chrome)
    // can run it. Without this, modern syntax (e.g. ??=) crashes old
    // Safari and the page renders blank/white.
    target: ["es2015", "safari11"],
  },
})
