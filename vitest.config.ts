import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/integration/**/*.test.tsx',
    ],
    exclude: ['node_modules', '.next', 'dist'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: [
        'src/lib/canvas/patch.ts',
        'src/lib/canvas/store.ts',
        'src/lib/agent/tools.ts',
        'src/components/canvas/Canvas.tsx',
      ],
    },
  },
});
