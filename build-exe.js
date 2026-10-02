// Builds dist/SimEx.exe – a single self-contained Windows program (Node "single executable application").
// Usage:  node build-exe.js      (needs Node 20+ and internet for the one-time `npx postject` download)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const files = ['index.html'];
const addDir = (d) => fs.readdirSync(path.join(root, d)).forEach((f) => files.push(d + '/' + f));
['css', 'js', 'lib'].forEach(addDir);

const assets = {};
files.forEach((f) => (assets[f] = path.join(root, f)));
const cfg = { main: path.join(root, 'server.js'), output: path.join(dist, 'sea-prep.blob'), disableExperimentalSEAWarning: true, assets };
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(cfg, null, 2));

console.log('1/3 creating blob with', files.length, 'embedded files…');
execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { stdio: 'inherit' });

const exe = path.join(dist, process.platform === 'win32' ? 'SimEx.exe' : 'SimEx');
console.log('2/3 copying the Node runtime →', exe);
fs.copyFileSync(process.execPath, exe);

console.log('3/3 injecting the app (npx postject)…');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['--yes', 'postject', exe, 'NODE_SEA_BLOB', path.join(dist, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(npx, args, { stdio: 'inherit', shell: process.platform === 'win32' });

fs.unlinkSync(path.join(dist, 'sea-prep.blob'));
fs.unlinkSync(path.join(dist, 'sea-config.json'));
console.log('\nDone →', exe, `(${(fs.statSync(exe).size / 1048576).toFixed(0)} MB)`);
