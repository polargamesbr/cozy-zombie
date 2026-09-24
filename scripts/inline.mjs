// Produces a single self-contained HTML file from the Vite build (run `npm run build` first):
//   dist/cozy-zombie.html          full document, open it by double-clicking
//   --fragment <path>              same page without <html>/<head>/<body> wrappers
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const js = [...html.matchAll(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/g)].map((m) => m[1]);
const css = [...html.matchAll(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/g)].map((m) => m[1]);
if (!js.length) throw new Error('no module script found in dist/index.html – run `npm run build` first');

const styles = css.map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
const scripts = js.map((f) => readFileSync(join(dist, f), 'utf8').replaceAll('</script', '<\\/script')).join('\n');

const body = `<div id="app"></div>\n<script type="module">\n${scripts}\n</script>`;
const full = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Cozy Zombie</title>
<style>
${styles}
</style>
</head>
<body>
${body}
</body>
</html>
`;
writeFileSync(join(dist, 'cozy-zombie.html'), full);
console.log(`dist/cozy-zombie.html (${(full.length / 1024).toFixed(0)} KB)`);

const i = process.argv.indexOf('--fragment');
if (i > 0 && process.argv[i + 1]) {
  const fragment = `<title>Cozy Zombie</title>\n<style>\n${styles}\n</style>\n${body}\n`;
  writeFileSync(process.argv[i + 1], fragment);
  console.log(`${process.argv[i + 1]} (${(fragment.length / 1024).toFixed(0)} KB)`);
}
