/**
 * server.js — Bitanex Signal API + WebSocket
 * Không HTML, chỉ API và socket.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const https = require('https');
const querystring = require('querystring');

// GẮN CỨNG TÀI KHOẢN
const EMAIL = 'dunggm2011@gmail.com';
const PASSWORD = 'duy11912';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

const BASE = 'https://bitanex2.net';
const LOGIN_URL = `${BASE}/login`;
const LOGIN_POST = `${BASE}/Account/LoginConfirm`;
const DATA_URL = `${BASE}/Home/GetData`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CANDLE_MS = 30000;
const CAPITAL_MIN = 2, CAPITAL_MAX = 10;

// ============================================================
// SESSION (tự login)
// ============================================================
let cookieJar = '', lastLogin = 0, loginPromise = null;

function httpsRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({ 'User-Agent': UA, 'Accept-Language': 'vi-VN,vi;q=0.9' }, opts.headers || {});
    if (cookieJar && !headers['Cookie']) headers['Cookie'] = cookieJar;

    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: opts.method || 'GET', headers, timeout: 20000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.headers['set-cookie']) {
          const jar = {};
          cookieJar.split('; ').filter(Boolean).forEach(c => { const [k, ...v] = c.split('='); jar[k] = v.join('='); });
          res.headers['set-cookie'].forEach(c => { const [kv] = c.split(';'); const [k, ...v] = kv.split('='); jar[k] = v.join('='); });
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
  cookieJar = '';
  await httpsRequest(LOGIN_URL, { headers: { 'Accept': 'text/html' } });
  const body = querystring.stringify({ Email: EMAIL, Password: PASSWORD });
  const r = await httpsRequest(LOGIN_POST, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': LOGIN_URL, 'Origin': BASE, 'X-Requested-With': 'XMLHttpRequest',
      'Content-Length': Buffer.byteLength(body),
    }, body,
  });
  const j = JSON.parse(r.body);
  if (j.code !== 3) throw new Error(`login fail code=${j.code}`);
  lastLogin = Date.now();
  console.log('[login] OK');
}

async function ensureLogin() {
  if (cookieJar && Date.now() - lastLogin < 25 * 60 * 1000) return;
  if (loginPromise) return loginPromise;
  loginPromise = doLogin().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function fetchCandles() {
  await ensureLogin();
  let r = await httpsRequest(DATA_URL, { headers: { 'Accept': 'application/json, text/plain, */*', 'Referer': `${BASE}/index`, 'Origin': BASE } });
  if (r.status === 302 || r.status === 401) {
    await doLogin();
    r = await httpsRequest(DATA_URL, { headers: { 'Accept': 'application/json, text/plain, */*', 'Referer': `${BASE}/index` } });
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(r.body);
  if (!j.candles || !j.candles.length) throw new Error('không có candles');
  return j.candles.sort((a, b) => a.startTime - b.startTime);
}

// ============================================================
// THUẬT TOÁN
// ============================================================
function sma(a, n) { return a.length >= n ? a.slice(-n).reduce((x, y) => x + y, 0) / n : null; }
function ema(a, n) {
  if (a.length < n) return null;
  const k = 2 / (n + 1); let e = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}
function stdev(a, n) {
  if (a.length < n) return null;
  const m = sma(a, n);
  return Math.sqrt(a.slice(-n).reduce((x, y) => x + (y - m) ** 2, 0) / n);
}
function rsiCalc(a, n = 14) {
  if (a.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = a.length - n; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; }
  const ag = g / n, al = l / n;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function macdCalc(a) { const e12 = ema(a, 12), e26 = ema(a, 26); return e12 == null || e26 == null ? null : e12 - e26; }
function stochK(c, n = 14) {
  if (c.length < n) return null;
  const hh = Math.max(...c.slice(-n).map(x => x.high)), ll = Math.min(...c.slice(-n).map(x => x.low));
  if (hh === ll) return 50;
  return (c[c.length - 1].close - ll) / (hh - ll) * 100;
}
function atrCalc(c, n = 14) {
  if (c.length < n + 1) return null;
  const trs = [];
  for (let i = c.length - n; i < c.length; i++) {
    const h = c[i].high, l = c[i].low, pc = c[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / n;
}

const INDICATORS = [
  c => { const cl = c.map(x => x.close), s9 = sma(cl, 9), s21 = sma(cl, 21); if (s9 == null || s21 == null) return [0, 1]; return [s9 > s21 ? 1 : -1, 1]; },
  c => { const cl = c.map(x => x.close), e12 = ema(cl, 12), e26 = ema(cl, 26); if (e12 == null || e26 == null) return [0, 1.2]; return [e12 > e26 ? 1 : -1, 1.2]; },
  c => { const r = rsiCalc(c.map(x => x.close), 14); if (r == null) return [0, 1]; if (r < 30) return [1, 1]; if (r > 70) return [-1, 1]; return [r > 50 ? 1 : -1, 0.3]; },
  c => { const m = macdCalc(c.map(x => x.close)); if (m == null) return [0, 1]; return [m > 0 ? 1 : -1, 1]; },
  c => {
    const cl = c.map(x => x.close), m = sma(cl, 20), s = stdev(cl, 20);
    if (m == null || s == null || s === 0) return [0, 1];
    const up = m + 2 * s, lo = m - 2 * s, pB = (cl[cl.length - 1] - lo) / (up - lo);
    if (pB < 0.1) return [1, 1]; if (pB > 0.9) return [-1, 1]; return [pB > 0.5 ? 1 : -1, 0.4];
  },
  c => { const cl = c.map(x => x.close); if (cl.length < 6) return [0, 1]; return [(cl[cl.length - 1] - cl[cl.length - 6]) > 0 ? 1 : -1, 0.9]; },
  c => { const k = stochK(c, 14); if (k == null) return [0, 1]; if (k < 20) return [1, 0.9]; if (k > 80) return [-1, 0.9]; return [k > 50 ? 1 : -1, 0.3]; },
  c => {
    const a = atrCalc(c, 14); if (a == null || c.length < 6) return [0, 0.5];
    const rel = a / c[c.length - 1].close, mom = c[c.length - 1].close - c[c.length - 6].close;
    if (rel > 0.001) return [mom > 0 ? 1 : -1, 0.7]; return [0, 0.7];
  },
];

function predict(candles) {
  const votes = INDICATORS.map(fn => { try { return fn(candles); } catch { return [0, 0]; } });
  const total_w = votes.reduce((a, x) => a + x[1], 0) || 1;
  const score = votes.reduce((a, x) => a + x[0] * x[1], 0) / total_w;
  const signal = score >= 0 ? 'BUY' : 'SELL';
  const confidence = Math.round(Math.abs(score) * 100);
  const capital_pct = +(CAPITAL_MIN + (confidence / 100) * (CAPITAL_MAX - CAPITAL_MIN)).toFixed(1);
  return { signal, confidence, capital_pct, close: candles[candles.length - 1].close };
}

// ============================================================
// STATE
// ============================================================
let activeSession = null;
const stats = { total: 0, correct: 0, wrong: 0 };
const history = [];
let cachedCandles = [];

function closeSession(closedCandle) {
  if (!activeSession) return null;
  const s = activeSession;
  const moveUp = closedCandle.close > closedCandle.open;
  const correct = (s.signal === 'BUY' && moveUp) || (s.signal === 'SELL' && !moveUp);

  stats.total++;
  if (correct) stats.correct++; else stats.wrong++;

  const item = {
    time: new Date(s.startTime).toLocaleTimeString('vi-VN'),
    startTime: s.startTime,
    signal: s.signal, confidence: s.confidence, capital_pct: s.capital_pct,
    price_at: s.price_at, close: closedCandle.close, correct,
  };
  history.unshift(item);
  if (history.length > 100) history.pop();
  activeSession = null;
  return item;
}

// ============================================================
// AUTO POLL — 3s gọi sàn 1 lần
// ============================================================
const POLL_MS = 3000;

setInterval(async () => {
  try {
    cachedCandles = await fetchCandles();
    const now = Date.now();
    if (activeSession) {
      const closedCandle = cachedCandles.find(c => c.startTime === activeSession.startTime);
      if (closedCandle && now >= activeSession.startTime + CANDLE_MS) {
        const item = closeSession(closedCandle);
        io.emit('session_closed', { item, stats });
        console.log(`[close] ${item.signal} ${item.correct ? '✅' : '❌'}`);
      }
    }
  } catch (e) {
    console.error('[poll] err:', e.message);
  }
}, POLL_MS);

// ============================================================
// WS TICK — đẩy trạng thái mỗi 500ms
// ============================================================
setInterval(() => {
  if (!cachedCandles.length) return;
  const live = cachedCandles[cachedCandles.length - 1];
  io.emit('tick', {
    live,
    remain: activeSession
      ? Math.max(0, Math.ceil((activeSession.startTime + CANDLE_MS - Date.now()) / 1000))
      : null,
    session: activeSession,
    stats,
  });
}, 500);

// ============================================================
// WEBSOCKET
// ============================================================
io.on('connection', (socket) => {
  console.log('[ws] connect', socket.id);
  socket.emit('init', {
    candles: cachedCandles.slice(-60),
    live: cachedCandles[cachedCandles.length - 1] || null,
    session: activeSession,
    stats,
    history: history.slice(0, 30),
  });
});

// ============================================================
// API
// ============================================================
app.use(express.json());

app.get('/api/doan', async (req, res) => {
  try {
    if (!cachedCandles.length) cachedCandles = await fetchCandles();
    const live = cachedCandles[cachedCandles.length - 1];
    const now = Date.now();

    if (activeSession) {
      const closedCandle = cachedCandles.find(c => c.startTime === activeSession.startTime);
      if (!(closedCandle && now >= activeSession.startTime + CANDLE_MS)) {
        const remain = Math.max(0, Math.ceil((activeSession.startTime + CANDLE_MS - now) / 1000));
        return res.json({ ok: true, locked: true, session: { ...activeSession, remain }, live });
      }
      const item = closeSession(closedCandle);
      io.emit('session_closed', { item, stats });
    }

    const pred = predict(cachedCandles);
    activeSession = {
      startTime: live.startTime,
      signal: pred.signal, confidence: pred.confidence,
      capital_pct: pred.capital_pct, price_at: pred.close,
    };
    const remain = Math.max(0, Math.ceil((live.startTime + CANDLE_MS - now) / 1000));
    io.emit('session_opened', { session: { ...activeSession, remain } });
    res.json({ ok: true, locked: true, session: { ...activeSession, remain }, live });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/ls', (req, res) => {
  const rate = stats.total > 0 ? +((stats.correct / stats.total) * 100).toFixed(1) : 0;
  res.json({
    ok: true,
    stats: { ...stats, rate },
    active: activeSession
      ? { ...activeSession, remain: Math.max(0, Math.ceil((activeSession.startTime + CANDLE_MS - Date.now()) / 1000)) }
      : null,
    history: history.slice(0, 50),
  });
});

app.get('/health', (req, res) => res.send('ok'));

// ============================================================
// START
// ============================================================
server.listen(PORT, () => {
  console.log(`[server] port ${PORT} — API + WebSocket (no HTML)`);
  ensureLogin().then(() => fetchCandles().then(c => { cachedCandles = c; }))
    .catch(e => console.error('[init] err:', e.message));
});
