const { nativeImage } = require('electron');
const http = require('http');
const https = require('https');

async function downloadImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const follow = (u) => {
      const p = new URL(u);
      mod.get({ hostname: p.hostname, path: p.pathname + (p.search || ''), headers: { 'User-Agent': 'AlmostControl/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    };
    follow(url);
  });
}

async function applyWindowIcon(url, win) {
  if (!url || !win) return;
  try {
    const buf = await downloadImageBuffer(url);
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) win.setIcon(img);
  } catch (e) { /* silently fail if URL is unreachable */ }
}

module.exports = { applyWindowIcon };