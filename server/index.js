import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function envInt(name, fallback, min = 1) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function envList(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

const PORT = envInt('PORT', 8080);
const HOST = process.env.HOST || '0.0.0.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DIST_PATH = path.join(__dirname, '..', 'client', 'dist');
const INDEX_PATH = path.join(DIST_PATH, 'index.html');
const STATIC_AVAILABLE = fs.existsSync(INDEX_PATH);

const ROOM_TTL_MS = envInt('ROOM_TTL_MS', 10 * 60 * 1000, 30_000);
const MAX_ROOMS = envInt('MAX_ROOMS', 500);
const MAX_CLIENTS = envInt('MAX_CLIENTS', 1000);
const MAX_CONNECTIONS_PER_MINUTE = envInt('MAX_CONNECTIONS_PER_MINUTE', 60);
const MAX_CONCURRENT_CONNECTIONS_PER_IP = envInt('MAX_CONCURRENT_CONNECTIONS_PER_IP', 20);
const MESSAGE_RATE_PER_SECOND = envInt('MESSAGE_RATE_PER_SECOND', 40);
const MESSAGE_BURST = envInt('MESSAGE_BURST', 80);
const MAX_SIGNAL_BYTES = envInt('MAX_SIGNAL_BYTES', 256 * 1024, 1024);

const DEFAULT_STUN_URLS = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.qq.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302'
];
const STUN_URLS = envList('STUN_URLS', DEFAULT_STUN_URLS);
const TURN_URLS = envList('TURN_URLS');
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const TURN_TTL_SECONDS = envInt('TURN_TTL_SECONDS', 3600, 60);
const ALLOWED_ORIGINS = new Set(envList('ALLOWED_ORIGINS'));

const rooms = new Map();
const clients = new Map();
const connectionsByIp = new Map();
const connectionWindows = new Map();

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const TOKEN_RE = /^[A-HJ-NP-Za-hj-np-z2-9]{8}$/;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function generateToken() {
  let token;
  do {
    token = Array.from({ length: 8 }, () => TOKEN_CHARS[crypto.randomInt(TOKEN_CHARS.length)]).join('');
  } while (rooms.has(token));
  return token;
}

function send(ws, type, data = {}) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type, ...data }));
  } catch (error) {
    console.error('Failed to send WebSocket message:', error);
  }
}

function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function isAllowedOrigin(origin, req) {
  if (!origin) return !IS_PRODUCTION;
  if (ALLOWED_ORIGINS.size > 0) return ALLOWED_ORIGINS.has(origin);

  const host = req.headers.host;
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return true;
  if (!IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
  return false;
}

function allowConnection(ip) {
  const now = Date.now();
  const current = connectionWindows.get(ip);
  if (!current || now - current.startedAt >= 60_000) {
    connectionWindows.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_CONNECTIONS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

function allowMessage(ws) {
  const now = Date.now();
  const elapsed = Math.max(0, now - ws.rateUpdatedAt) / 1000;
  ws.rateTokens = Math.min(MESSAGE_BURST, ws.rateTokens + elapsed * MESSAGE_RATE_PER_SECOND);
  ws.rateUpdatedAt = now;
  if (ws.rateTokens < 1) {
    ws.rateViolations += 1;
    send(ws, 'error', { message: '请求过于频繁，请稍后重试' });
    if (ws.rateViolations >= 20) ws.terminate();
    return false;
  }
  ws.rateTokens -= 1;
  return true;
}

function validateSignalData(data) {
  if (!isPlainObject(data)) return false;
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_SIGNAL_BYTES) return false;

  if (data.type === 'offer' || data.type === 'answer') {
    return isPlainObject(data.sdp)
      && data.sdp.type === data.type
      && typeof data.sdp.sdp === 'string';
  }
  if (data.type === 'ice') {
    return isPlainObject(data.candidate) && typeof data.candidate.candidate === 'string';
  }
  return false;
}
function cleanupRoom(token) {
  const room = rooms.get(token);
  if (!room) return;
  for (const ws of [room.sender, room.receiver]) {
    if (!ws) continue;
    const info = clients.get(ws);
    if (info?.token === token) clients.delete(ws);
  }
  rooms.delete(token);
}

function leaveCurrentRoom(ws, message = '对方已离开') {
  const info = clients.get(ws);
  if (!info?.token) return;
  const token = info.token;
  const room = rooms.get(token);
  if (room) {
    const peer = info.role === 'sender' ? room.receiver : room.sender;
    if (peer && peer.readyState === WebSocket.OPEN) send(peer, 'peer-left', { message });
  }
  cleanupRoom(token);
  info.token = null;
  info.role = null;
}

function tryMatch(token) {
  const room = rooms.get(token);
  if (!room || room.matched) return;
  if (room.sender && room.receiver) {
    room.matched = true;
    send(room.sender, 'matched', { role: 'sender' });
    send(room.receiver, 'matched', { role: 'receiver' });
  }
}

function handleClientMessage(ws, raw) {
  if (!allowMessage(ws)) return;

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    send(ws, 'error', { message: '消息格式无效' });
    return;
  }
  if (!isPlainObject(msg) || typeof msg.type !== 'string') {
    send(ws, 'error', { message: '消息格式无效' });
    return;
  }

  const info = clients.get(ws);
  if (!info) return;

  if (msg.type === 'create-room') {
    if (info.token) return send(ws, 'error', { message: '当前连接已加入房间' });
    if (rooms.size >= MAX_ROOMS) return send(ws, 'error', { message: '服务器房间已满，请稍后重试' });
    const role = msg.role;
    if (role !== 'sender' && role !== 'receiver') return send(ws, 'error', { message: '角色无效' });

    const token = generateToken();
    rooms.set(token, {
      sender: role === 'sender' ? ws : null,
      receiver: role === 'receiver' ? ws : null,
      createdAt: Date.now(),
      matched: false
    });
    info.token = token;
    info.role = role;
    send(ws, 'room-created', { token, expiresAt: Date.now() + ROOM_TTL_MS });
    tryMatch(token);
    return;
  }

  if (msg.type === 'join-room') {
    if (info.token) return send(ws, 'error', { message: '当前连接已加入房间' });
    const role = msg.role;
    const token = msg.token;
    if (role !== 'sender' && role !== 'receiver') return send(ws, 'error', { message: '角色无效' });
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      return send(ws, 'error', { message: 'Token 格式无效' });
    }
    const room = rooms.get(token);
    if (!room) return send(ws, 'error', { message: 'Token 不存在或已失效' });
    if (room[role]) {
      return send(ws, 'error', {
        message: `该 Token 已有${role === 'sender' ? '发送方' : '接收方'}在等待，请选择相反角色`
      });
    }
    room[role] = ws;
    info.token = token;
    info.role = role;
    send(ws, 'room-joined', { token, expiresAt: room.createdAt + ROOM_TTL_MS });
    tryMatch(token);
    return;
  }

  if (msg.type === 'signal') {
    if (!info.token) return send(ws, 'error', { message: '尚未加入房间' });
    if (!validateSignalData(msg.data)) return send(ws, 'error', { message: '信令数据无效' });
    const room = rooms.get(info.token);
    if (!room || !room.matched) return;
    const peer = info.role === 'sender' ? room.receiver : room.sender;
    if (peer && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify({ type: 'signal', data: msg.data }));
    }
    return;
  }

  if (msg.type === 'leave-room') {
    leaveCurrentRoom(ws, '对方已结束会话');
    return;
  }

  send(ws, 'error', { message: '未知消息类型' });
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  };
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function buildIceServers() {
  const iceServers = [];
  if (STUN_URLS.length > 0) iceServers.push({ urls: STUN_URLS });
  if (TURN_URLS.length === 0) return iceServers;

  if (TURN_SECRET) {
    const expires = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
    const username = `${expires}:airdropweb`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: TURN_URLS, username, credential });
  } else if (TURN_USERNAME && TURN_CREDENTIAL) {
    iceServers.push({ urls: TURN_URLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
  }
  return iceServers;
}
async function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const isHashedAsset = filePath.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => {
    console.error('Static file stream failed:', error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
  return true;
}

async function handleHttpRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...securityHeaders(), Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, securityHeaders());
    res.end('Bad Request');
    return;
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      rooms: rooms.size,
      clients: clients.size,
      uptime: Math.round(process.uptime())
    });
  }
  if (url.pathname === '/api/ice-config') {
    return sendJson(res, 200, { iceServers: buildIceServers() });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, securityHeaders());
    res.end('Bad Request');
    return;
  }

  if (!STATIC_AVAILABLE) {
    res.writeHead(200, { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('P2P File Transfer Signaling Server. Build client/dist to serve frontend.');
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(DIST_PATH, relativePath);
  const relative = path.relative(DIST_PATH, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    res.writeHead(403, securityHeaders());
    res.end('Forbidden');
    return;
  }

  if (await serveFile(req, res, filePath)) return;
  if (!path.extname(relativePath)) {
    if (await serveFile(req, res, INDEX_PATH)) return;
  }
  res.writeHead(404, { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((error) => {
    console.error('HTTP request failed:', error);
    if (!res.headersSent) res.writeHead(500, securityHeaders());
    res.end('Internal Server Error');
  });
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_SIGNAL_BYTES,
  verifyClient: (info, done) => {
    const ip = getClientIp(info.req);
    if (shuttingDown) return done(false, 503, 'Server is shutting down');
    if (clients.size >= MAX_CLIENTS) return done(false, 503, 'Server is busy');
    if ((connectionsByIp.get(ip) || 0) >= MAX_CONCURRENT_CONNECTIONS_PER_IP) {
      return done(false, 429, 'Too many concurrent connections');
    }
    if (!isAllowedOrigin(info.origin, info.req)) return done(false, 403, 'Origin not allowed');
    if (!allowConnection(ip)) return done(false, 429, 'Too many connections');
    done(true);
  }
});

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) {
    ws.close(1013, 'Server is busy');
    return;
  }

  const ip = getClientIp(req);
  connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);
  clients.set(ws, { token: null, role: null, ip });
  ws.isAlive = true;
  ws.rateTokens = MESSAGE_BURST;
  ws.rateUpdatedAt = Date.now();
  ws.rateViolations = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (message) => {
    try {
      handleClientMessage(ws, message);
    } catch (error) {
      console.error('WebSocket message failed:', error);
      send(ws, 'error', { message: '服务器处理消息失败' });
    }
  });
  ws.on('close', () => {
    const count = (connectionsByIp.get(ip) || 1) - 1;
    if (count > 0) connectionsByIp.set(ip, count);
    else connectionsByIp.delete(ip);
    leaveCurrentRoom(ws, '对方连接已断开');
    clients.delete(ws);
  });
});

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

const roomCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, room] of rooms) {
    if (!room.matched && now - room.createdAt > ROOM_TTL_MS) {
      if (room.sender) send(room.sender, 'error', { message: '房间超时已失效' });
      if (room.receiver) send(room.receiver, 'error', { message: '房间超时已失效' });
      cleanupRoom(token);
    }
  }
}, 60_000);

const abuseCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, window] of connectionWindows) {
    if (now - window.startedAt > 120_000) connectionWindows.delete(ip);
  }
}, 120_000);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  clearInterval(heartbeatInterval);
  clearInterval(roomCleanupInterval);
  clearInterval(abuseCleanupInterval);
  for (const ws of wss.clients) {
    try { ws.close(1001, 'Server shutting down'); } catch {}
  }
  wss.close();
  const forceExit = setTimeout(() => {
    console.log('Force exiting after timeout');
    process.exit(1);
  }, 3000);
  forceExit.unref();
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(`Signaling server running on ${HOST}:${PORT}`);
});
