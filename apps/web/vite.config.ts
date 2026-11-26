import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const noFonts = fileURLToPath(new URL('./src/demo/no-fonts.css', import.meta.url));

/** Hosted preview: IBM Plex comes from Google Fonts rather than bundled font files. */
const googleFonts: Plugin = {
  name: 'google-fonts',
  transformIndexHtml: (html) =>
    html.replace(
      '</head>',
      '<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin /><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;500;600&display=swap" /></head>',
    ),
};

export default defineConfig(({ mode }) => {
  const preview = mode === 'preview-static';
  return {
    plugins: [react(), ...(preview ? [googleFonts] : [])],
    // The static preview (npm run build:preview) uses relative asset paths so it can be hosted anywhere.
    base: preview ? './' : '/',
    resolve: preview ? { alias: [{ find: /^@fontsource\/.*\.css$/, replacement: noFonts }] } : undefined,
    server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
    build: { chunkSizeWarningLimit: 2500, outDir: preview ? 'dist-preview' : 'dist' },
  };
});
