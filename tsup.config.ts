import { defineConfig } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';

export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  async onSuccess() {
    await mkdir('dist/eval/assets', { recursive: true });
    await Promise.all([
      copyFile('eval/cases.jsonl', 'dist/eval/assets/cases.jsonl'),
      copyFile('eval/injection-templates.json', 'dist/eval/assets/injection-templates.json'),
    ]);
  },
});
