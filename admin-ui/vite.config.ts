/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/app',
  resolve: {
    // Redirect @mui/icons-material CJS sub-paths to their ESM equivalents.
    // Without this, esbuild pre-bundles the CJS files with isNodeMode=1,
    // which causes "type is invalid – got: object" for icon components.
    alias: [
      {
        find: /^@mui\/icons-material\/(?!esm\/)(.+)$/,
        replacement: '@mui/icons-material/esm/$1',
      },
    ],
  },
  server: {
    proxy: {
      // Proxy /api/manage → production, so dev builds bypass CORS restrictions.
      // Used together with VITE_API_URL=/api/manage in .env.development.local
      '/api/manage': {
        target: 'https://voice.activi.io',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'mui-vendor': ['@mui/material', '@mui/icons-material'],
          'ra-vendor': ['react-admin'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
      },
    },
    setupFiles: ['./src/test-setup.ts'],
  },
});
