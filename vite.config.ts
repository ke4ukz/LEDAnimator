import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the build works on GitHub Pages project sites
// (https://<user>.github.io/<repo>/) regardless of the repo name.
// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
})
