import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: 2,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'json', 'json-summary', 'html'],
      include: [
        'src/policy/**/*.ts',
        'src/gate/**/*.ts',
        'src/protocols/*/stream.ts',
      ],
      exclude: [],
      thresholds: {
        lines: 90,
        autoUpdate: false,
        'src/policy/**/*.ts': { lines: 90 },
        'src/gate/**/*.ts': { lines: 90 },
        'src/protocols/*/stream.ts': { lines: 90, perFile: true },
      },
    },
  },
});
