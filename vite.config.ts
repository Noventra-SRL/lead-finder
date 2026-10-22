import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// L'interfaccia chiama sempre /api sulla propria origine: Vite inoltra le richieste al server API,
// così cookie e controllo dell'origine funzionano come in produzione (stessa origine, nessun CORS).
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8810';
const port = Number(process.env.WEB_PORT ?? 5210);

export default defineConfig({
  plugins: [react()],
  build: {
    // nessun file incorporato come data: URI (Vite lo fa per i file piccoli, es. sottoinsiemi dei font):
    // la Content-Security-Policy del server ammette solo risorse della stessa origine
    assetsInlineLimit: 0,
  },
  server: {
    port,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: {
    port,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
});
