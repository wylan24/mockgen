import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // The app calls /api/...; in development that goes to the mock server.
    // Point this at your real API when it exists; the app code doesn't change.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4010', rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
});
