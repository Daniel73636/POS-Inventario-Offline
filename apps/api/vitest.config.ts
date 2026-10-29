import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emite metadatos de decoradores, necesarios para la inyección de dependencias de Nest.
export default defineConfig({
  test: { globals: false, testTimeout: 60000, hookTimeout: 60000 },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
