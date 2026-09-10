import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Im Entwicklungsmodus laeuft Vite auf 5173 und reicht alles, was nach
 * /api oder /ws geht, an den Node-Server auf 8080 weiter. Im Betrieb
 * liefert der Node-Server das gebaute Frontend selbst aus - dann gibt es
 * nur eine URL und kein CORS.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
