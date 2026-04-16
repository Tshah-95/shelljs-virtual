import path from 'node:path';

const root = process.cwd();
const distDir = path.join(root, 'dist');

await Bun.$`rm -rf ${distDir}`.quiet();

const result = await Bun.build({
  entrypoints: [path.join(root, 'src/index.ts')],
  outdir: distDir,
  format: 'esm',
  target: 'node',
  minify: false,
  splitting: false,
  sourcemap: 'external',
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log.message);
  }
  process.exit(1);
}

const declarations = await Bun.file(path.join(root, 'src/public-api.d.ts')).text();
await Bun.write(path.join(distDir, 'index.d.ts'), declarations);
