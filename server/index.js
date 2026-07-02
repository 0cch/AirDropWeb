import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

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
    if (ws && ws.readyState === ws.OPEN) {
      clients.delete(ws);
    }
  }
  rooms.delete(token);
}

const server = http.createServer((req, res) => {
  // 健康检查
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  // 生产环境托管前端静态文件
  const distPath = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(distPath)) {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(distPath, filePath);
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html', '.js': 'text/javascript',
      '.css': 'text/css', '.json': 'application/json',
      '.png': 'image/png', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.woff2': 'font/woff2'
    };
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      // SPA fallback
      try {
        const index = fs.readFileSync(path.join(distPath, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
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

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.set(ws, null);

  ws.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch {
      return send(ws, 'error', { message: 'Invalid JSON' });
    }

    const { type } = msg;

    if (type === 'create-room') {
      const role = msg.role; // 'sender' | 'receiver'
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
      // 转发给房间里的另一方
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

function tryMatch(token) {
  const room = rooms.get(token);
  if (!room) return;
  if (room.sender && room.receiver) {
    // 双方都在，通知配对成功
    // sender 作为 WebRTC 的 offer 方
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

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
