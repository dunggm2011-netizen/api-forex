/**
 * server.js — Bitanex Signal Web
 * Proxy tới bitanex2.net, tự login, cung cấp API + serve HTML.
 *
 * Chạy: node server.js
 * Env: PORT, BITANEX_EMAIL, BITANEX_PASSWORD
 */
const express = require('express');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

const app = express();
const PORT = process.env.PORT || 3000;

const EMAIL = process.env.BITANEX_EMAIL || 'dunggm2011@gmail.com';
const PASSWORD = process.env.BITANEX_PASSWORD || 'duy11912';

const BASE = 'https://bitanex2.net';
const LOGIN_URL = `${BASE}/login`;
const LOGIN_POST = `${BASE}/Account/LoginConfirm`;
const DATA_URL = `${BASE}/Home/GetData`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ============================================================
// Session — giữ cookie, tự login lại khi hết hạn
// ============================================================
let cookieJar = '';
let lastLogin = 0;
let loginPromise = null;

function httpsRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
    }, opts.headers || {});
    if (cookieJar && !headers['Cookie']) headers['Cookie'] = cookieJar;

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
      timeout: 20000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          // ghép cookie mới
          const jar = {};
          cookieJar.split('; ').filter(Boolean).forEach(c => {
            const [k, ...v] = c.split('=');
            jar[k] = v.join('=');
          });
          setCookie.forEach(c => {
            const [kv] = c.split(';');
            const [k, ...v] = kv.split('=');
            jar[k] = v.join('=');
          });
          cookieJar = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function doLogin() {
  console.log('[login] đang đăng nhập…');
  cookieJar = '';
  // GET /login lấy cookie khởi tạo
  await httpsRequest(LOGIN_URL, { headers: { 'Accept': 'text/html' } });

  const body = querystring.stringify({ Email: EMAIL, Password: PASSWORD });
  const r = await httpsRequest(LOGIN_POST, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': LOGIN_URL,
      'Origin': BASE,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  let j;
  try { j = JSON.parse(r.body); }
  catch { throw new Error(`login response không phải JSON: ${r.body.slice(0,150)}`); }

  if (j.code !== 3) {
    throw new Error(`login fail code=${j.code}`);
  }
  lastLogin = Date.now();
  console.log('[login] OK, cookies:', cookieJar.length, 'bytes');
}

async function ensureLogin() {
  if (cookieJar && Date.now() - lastLogin < 25 * 60 * 1000) return;
  if (loginPromise) return loginPromise;
  loginPromise = doLogin().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function fetchCandles() {
  await ensureLogin();
  let r = await httpsRequest(DATA_URL, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': `${BASE}/index`,
      'Origin': BASE,
    },
  });
  if (r.status === 302 || r.status === 401) {
    console.log('[fetch] cookie hết hạn, login lại…');
    await doLogin();
    r = await httpsRequest(DATA_URL, {
      headers: { 'Accept': 'application/json, text/plain, */*', 'Referer': `${BASE}/index` },
    });
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(r.body);
  if (!j.candles || !j.candles.length) throw new Error('không có candles');
  return j;
}

// ============================================================
// API
// ============================================================
app.get('/api/candles', async (req, res) => {
  try {
    const j = await fetchCandles();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, candles: j.candles, fetchedAt: Date.now() });
  } catch (e) {
    console.error('[api] err:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.send('ok'));

// ============================================================
// Static
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
  // login trước khi phục vụ
  ensureLogin().catch(e => console.error('[init] login fail:', e.message));
});
