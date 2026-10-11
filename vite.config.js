import { defineConfig } from 'vite';

export default defineConfig(({ command, isPreview }) => ({
  // GitHub Pages hosts this repository under /booyah/. Keep local development
  // at the existing root URL; preview serves the same paths as production.
  base: command === 'serve' && !isPreview ? '/' : '/booyah/',
}));
