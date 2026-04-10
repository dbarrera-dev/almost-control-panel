const https = require('https');

function httpsRequest(method, hostname, path, headers, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const buf = body ? Buffer.from(body) : null;
    const opts = { hostname, path, method, headers: { ...headers, ...(buf ? { 'Content-Length': buf.length } : {}) } };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 204) { resolve({ status: 204, data: null }); return; }
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', (err) => {
      resolve({ status: 0, data: { error: err?.message || String(err) } });
    });
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error('Timeout')); } catch {}
    });
    if (buf) req.write(buf);
    req.end();
  });
}

module.exports = { httpsRequest };
