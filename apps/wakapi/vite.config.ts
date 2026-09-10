import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { bridgething, daemonProxy } from './scripts/bridgething.ts';

export default defineConfig(async () => ({
  plugins: [preact(), bridgething()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: true,
    proxy: await daemonProxy(),
  },
}));
