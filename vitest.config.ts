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
    // Vitest 5 default `pool: 'forks'` is more reliable for jsdom + Next
    // module mocks than the v4 `threads` default. Explicit here so a future
    // major bump doesn't silently flip isolation semantics.
    pool: 'forks',
    // Auto-restore mocks + spies + modules after every test, closing the
    // cleanup gap across ~10 test files that use `vi.fn()` without an
    // `afterEach(vi.restoreAllMocks)`. Cheaper than per-file `afterEach`
    // because it runs in the runner, not per-test user code.
    restoreMocks: true,
    // Clear mock state (call counts, etc.) between tests within a file.
    clearMocks: true,
    // Don't reload the module registry between tests in the same file —
    // only reset mock implementations. (Combines with `restoreMocks` to
    // give "fresh mock, fresh module" semantics across files.)
    mockReset: false,
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
      // Coverage thresholds — turn the existing `coverage.include` list from
      // an advisory "we measure these" gate into a "we don't regress these"
      // gate. Tuned to current coverage so CI fails on regressions only.
      // Bump these numbers as coverage improves; never lower them.
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
