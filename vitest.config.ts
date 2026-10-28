import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'src/policy/**/*.ts',
        'src/gate/**/*.ts',
        'src/protocols/**/stream.ts',
      ],
      thresholds: {
        lines: 90,
      },
    },
  },
});
