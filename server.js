// SimEx local server – serves the app and keeps your accounts/trades in data/state.json
// Works in two modes:
//   • "node server.js"  (needs Node.js)       – serves the files next to this script
//   • SimEx.exe          (single-file build)   – serves the files embedded in the exe and opens your browser
// Data folder: ./data next to server.js / next to SimEx.exe.   Stop: close the window, Ctrl+C or stop.bat
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let sea = null;
try {
  const m = require('node:sea');
  if (m.isSea()) sea = m;
} catch (e) { /* not a single-executable build */ }

const PORT = +process.env.PORT || 8765;
const BASE = sea ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(BASE, 'data');
const STATE = path.join(DATA_DIR, 'state.json');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
fs.mkdirSync(DATA_DIR, { recursive: true });

function backupRotate() {
  // keep one daily backup of the state file (last 14 days)
  try {
    if (!fs.existsSync(STATE)) return;
    const day = new Date().toISOString().slice(0, 10);
    const b = path.join(DATA_DIR, `backup-${day}.json`);
    if (!fs.existsSync(b)) fs.copyFileSync(STATE, b);
    const old = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('backup-')).sort().slice(0, -14);
    old.forEach((f) => fs.unlinkSync(path.join(DATA_DIR, f)));
  } catch (e) { /* ignore */ }
}

function sendStatic(url, res) {
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const type = TYPES[path.extname(rel)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
  if (sea) {
    let buf;
    try { buf = Buffer.from(sea.getAsset(rel)); } catch (e) { if (process.env.SIMEX_DEBUG) console.log("asset error", rel, e.message); res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, headers);
    return res.end(buf);
  }
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname) || file.startsWith(DATA_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/api/state') {
    if (req.method === 'GET') {
      if (!fs.existsSync(STATE)) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return fs.createReadStream(STATE).pipe(res);
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          JSON.parse(body); // validate
          const tmp = STATE + '.tmp';
          fs.writeFileSync(tmp, body);
          fs.renameSync(tmp, STATE);
          res.writeHead(204);
        } catch (e) {
          res.writeHead(400);
        }
        res.end();
      });
      return;
    }
  }
  if (url === '/api/quit') {
    res.writeHead(200); res.end('bye');
    console.log('Stopped via /api/quit');
    return setTimeout(() => process.exit(0), 100);
  }
  sendStatic(url, res);
});

const openBrowser = () => {
  if (process.env.NO_OPEN) return;
  if (process.platform === 'win32') exec(`start "" "http://localhost:${PORT}"`);
  else if (process.platform === 'darwin') exec(`open "http://localhost:${PORT}"`);
  else exec(`xdg-open "http://localhost:${PORT}"`);
};

server.listen(PORT, '127.0.0.1', () => {
  backupRotate();
  console.log(`\n  SimEx running →  http://localhost:${PORT}\n  Data folder   →  ${DATA_DIR}\n  (close this window or press Ctrl+C to stop)\n`);
  if (sea) openBrowser(); // start.bat opens the browser itself in script mode
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  SimEx is already running on port ${PORT} – opening http://localhost:${PORT}\n`);
    if (sea) openBrowser();
  } else console.error(e);
  setTimeout(() => process.exit(1), sea ? 1500 : 0);
});
