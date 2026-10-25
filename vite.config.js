import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // Set base for GitHub Pages deployment at:
  // https://hrakashchauhan.github.io/posturesense-ai/
  base: process.env.GITHUB_PAGES === 'true' ? '/posturesense-ai/' : '/',
})
