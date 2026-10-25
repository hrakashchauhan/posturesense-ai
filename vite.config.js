import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  base: process.env.GITHUB_PAGES === 'true' ? '/posturesense-ai/' : '/',
})
