import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true
      },
      '/api': {
        target: 'http://127.0.0.1:8080'
      }
    }
  }
});
