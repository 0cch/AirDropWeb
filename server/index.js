import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// Token -> Room 映射
const rooms = new Map();
// WebSocket -> Room 信息映射
const clients = new Map();

function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let token = '';
  for (let i = 0; i < 8; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(token) ? generateToken() : token;
}

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function cleanupRoom(token) {
  const room = rooms.get(token);
  if (!room) return;
  for (const ws of [room.sender, room.receiver]) {
    if (ws) clients.delete(ws);
  }
  rooms.delete(token);
}

// MIME 类型映射
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
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // 安全：阻止路径穿越
  // 健康检查
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }

  const distPath = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(distPath)) {
    // 解析 URL，阻止路径穿越
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // 安全检查：确保路径在 distPath 内
    const filePath = path.normalize(path.join(distPath, pathname));
    if (!filePath.startsWith(distPath)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath);
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      // SPA fallback — 所有未匹配的路由返回 index.html
      try {
        const index = fs.readFileSync(path.join(distPath, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(index);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('P2P File Transfer Signaling Server. Build client/dist to serve frontend.');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 }); // 限制信令消息大小 1MB

wss.on('connection', (ws, req) => {
  clients.set(ws, null);

  // 心跳检测：30 秒无响应则断开
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch {
      return send(ws, 'error', { message: 'Invalid JSON' });
    }

    const { type } = msg;

    if (type === 'create-room') {
      const role = msg.role;
      if (!['sender', 'receiver'].includes(role)) {
        return send(ws, 'error', { message: 'Invalid role' });
      }
      const token = generateToken();
      rooms.set(token, {
        sender: role === 'sender' ? ws : null,
        receiver: role === 'receiver' ? ws : null,
        createdAt: Date.now()
      });
      clients.set(ws, { token, role });
      send(ws, 'room-created', { token });
      tryMatch(token);
    }

    else if (type === 'join-room') {
      const { token, role } = msg;
      if (!['sender', 'receiver'].includes(role)) {
        return send(ws, 'error', { message: 'Invalid role' });
      }
      const room = rooms.get(token);
      if (!room) {
        return send(ws, 'error', { message: 'Token 不存在或已失效' });
      }
      const existingRole = role === 'sender' ? 'sender' : 'receiver';
      if (room[existingRole]) {
        return send(ws, 'error', { message: `该 Token 已有${role === 'sender' ? '发送方' : '接收方'}在等待，请选择相反角色` });
      }
      room[existingRole] = ws;
      clients.set(ws, { token, role });
      send(ws, 'room-joined', { token });
      tryMatch(token);
    }

    else if (type === 'signal') {
      const clientInfo = clients.get(ws);
      if (!clientInfo) return;
      const room = rooms.get(clientInfo.token);
      if (!room) return;
      const peer = clientInfo.role === 'sender' ? room.receiver : room.sender;
      if (peer && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ type: 'signal', data: msg.data }));
      }
    }

    else if (type === 'file-meta') {
      const clientInfo = clients.get(ws);
      if (!clientInfo) return;
      const room = rooms.get(clientInfo.token);
      if (!room) return;
      const peer = clientInfo.role === 'sender' ? room.receiver : room.sender;
      if (peer && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ type: 'file-meta', data: msg.data }));
      }
    }
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      const room = rooms.get(clientInfo.token);
      if (room) {
        const peer = clientInfo.role === 'sender' ? room.receiver : room.sender;
        if (peer && peer.readyState === peer.OPEN) {
          peer.send(JSON.stringify({ type: 'peer-left' }));
        }
        cleanupRoom(clientInfo.token);
      }
    }
    clients.delete(ws);
  });
});

// 心跳：每 30 秒检查连接存活
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = true;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

function tryMatch(token) {
  const room = rooms.get(token);
  if (!room) return;
  if (room.sender && room.receiver) {
    send(room.sender, 'matched', { role: 'sender' });
    send(room.receiver, 'matched', { role: 'receiver' });
  }
}

// 清理超时房间（10分钟未配对）
setInterval(() => {
  const now = Date.now();
  for (const [token, room] of rooms) {
    if (now - room.createdAt > 10 * 60 * 1000 && (!room.sender || !room.receiver)) {
      if (room.sender) send(room.sender, 'error', { message: '房间超时已失效' });
      if (room.receiver) send(room.receiver, 'error', { message: '房间超时已失效' });
      cleanupRoom(token);
    }
  }
}, 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`Signaling server running on ${HOST}:${PORT}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(signal + ' received, shutting down...');
  clearInterval(heartbeatInterval);
  for (const ws of wss.clients) { try { ws.close(1001, 'Server shutting down'); } catch {} }
  wss.close();
  const forceExit = setTimeout(() => { console.log('Force exiting after timeout'); process.exit(1); }, 3000);
  forceExit.unref();
  server.close(() => { clearTimeout(forceExit); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
