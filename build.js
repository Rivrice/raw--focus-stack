// Builds the single-file app: index.html (GitHub Pages / any static host).
const fs = require('fs'), path = require('path');
const s = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const core = ['tiff.js', 'ljpeg.js', 'dng.js', 'align.js', 'engine.js', 'output.js', 'worker.js'].map(s).join('\n');
if (/<\/script/i.test(core + s('ui.js'))) throw new Error('script close tag in source');
const page = s('page.html').replace('/*__CORE__*/', () => core).replace('/*__UI__*/', () => s('ui.js'));
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
// Body-only page (for hosts that add their own document skeleton, e.g. claude.ai Artifacts)
fs.writeFileSync(path.join(__dirname, 'dist/raw-focus-stack.html'), page);
const full = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style></head><body>' + page + '</body></html>';
fs.writeFileSync(path.join(__dirname, 'index.html'), full);
console.log('built index.html', full.length, 'bytes');
