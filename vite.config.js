import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  root: 'public',
  resolve: {
    alias: {
      '/src': path.resolve(__dirname, 'src')
    }
  },
  server: {
    https: {
      key: fs.readFileSync('key.pem'),
      cert: fs.readFileSync('cert.pem'),
    },
    host: true
  }
});