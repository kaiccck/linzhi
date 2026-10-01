import { defineConfig, defaultClientConditions, defaultServerConditions, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Fontsource's CSS lists a .woff fallback next to every .woff2 slice. Every browser that can run the
 * WebGL basemap reads woff2, so drop the fallback and halve the font files a build emits.
 */
function woff2Only(): Plugin {
  return {
    name: 'zdd:woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@fontsource[\\/].+\.css$/.test(id)) return null;
      return { code: code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, ''), map: null };
    },
  };
}

// where /api goes in dev and preview; ZDD_API_PROXY points a second checkout at its own server
const api = process.env.ZDD_API_PROXY || 'http://localhost:8787';

export default defineConfig({
  plugins: [woff2Only(), react()],
  // read VITE_* vars (only the browser AK) from the repo-root .env.local; server keys never reach the client
  envDir: '../../',
  resolve: { conditions: ['source', ...defaultClientConditions] },
  // tests run server-side: inline the workspace core and read its source, as the app does (its dist/
  // is only built for publishing and may lag behind)
  ssr: { noExternal: ['@zoudedao/core'], resolve: { conditions: ['source', ...defaultServerConditions] } },
  server: { port: 5173, proxy: { '/api': api } },
  preview: { port: 4173, proxy: { '/api': api } },
});
