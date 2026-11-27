import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error Build helper is shared with the Node deployment entrypoint.
import { resolveAgentRepository } from '../scripts/repository.mjs';

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __AGENT_REPOSITORY__: JSON.stringify(resolveAgentRepository(new URL('..', import.meta.url))),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
