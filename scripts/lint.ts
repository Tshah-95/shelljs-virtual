import path from 'node:path';

const root = process.cwd();
const errors: string[] = [];

const files = Array.from(new Bun.Glob('src/**/*.ts').scanSync({ cwd: root }));

for (const relativePath of files) {
  const fullPath = path.join(root, relativePath);
  const source = await Bun.file(fullPath).text();

  if (/require\s*\(\s*['"]fs['"]\s*\)/.test(source) || /from\s+['"]node:fs['"]/.test(source)) {
    errors.push(`${relativePath}: production code must not depend on the real filesystem`);
  }

  if (/\t/.test(source)) {
    errors.push(`${relativePath}: tabs are not allowed`);
  }

  if (/[ \t]+$/m.test(source)) {
    errors.push(`${relativePath}: trailing whitespace detected`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}
