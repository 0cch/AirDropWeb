import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, '..', 'index.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('Server did not become ready');
}

function rawHttpRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Raw HTTP request timed out'));
    }, 3000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => {
      clearTimeout(timeout);
      resolve(response);
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
  });
}

test('signaling server survives hostile input and enforces one room per connection', async (t) => {
  const port = await findFreePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      TURN_URLS: 'turn:turn.example.com:3478',
      TURN_SECRET: 'test-turn-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    }
  });

  await waitForServer(port, child);
  const iceConfig = await fetch(`http://127.0.0.1:${port}/api/ice-config`).then((response) => response.json());
  assert.deepEqual(iceConfig.iceServers[1].urls, ['turn:turn.example.com:3478']);
  assert.ok(iceConfig.iceServers[1].username.includes(':airdropweb'));
  assert.ok(iceConfig.iceServers[1].credential.length > 20);

  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const rejectedStatus = await new Promise((resolve, reject) => {
    const rejected = new WebSocket(wsUrl, { headers: { Origin: 'https://evil.example' } });
    rejected.on('unexpected-response', (_request, response) => resolve(response.statusCode));
    rejected.on('error', reject);
  });
  assert.equal(rejectedStatus, 403);

  const ws = new WebSocket(wsUrl, { headers: { Origin: `http://127.0.0.1:${port}` } });
  await once(ws, 'open');
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

  ws.send('null');
  await delay(150);
  assert.equal(child.exitCode, null, stderr);
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(health.status, 'ok');

  ws.send(JSON.stringify({ type: 'create-room', role: 'sender' }));
  await delay(150);
  const created = messages.find((message) => message.type === 'room-created');
  assert.ok(created, 'room-created response expected');
  assert.match(created.token, /^[A-HJ-NP-Za-hj-np-z2-9]{8}$/);
  assert.ok(created.expiresAt > Date.now());

  ws.send(JSON.stringify({ type: 'create-room', role: 'sender' }));
  await delay(150);
  assert.ok(messages.some((message) => message.type === 'error' && message.message === '当前连接已加入房间'));

  ws.close();
  await once(ws, 'close');

  const rawResponse = await rawHttpRequest(
    port,
    'GET /% HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
  );
  assert.match(rawResponse, /^HTTP\/1\.1 400/);
  assert.equal(child.exitCode, null, stderr);
});

test('resumes a paired room after a transient WebSocket disconnect', async (t) => {
  const port = await findFreePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      ROOM_RESUME_GRACE_MS: '2000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    }
  });
  await waitForServer(port, child);

  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const origin = `http://127.0.0.1:${port}`;
  const sender = new WebSocket(wsUrl, { headers: { Origin: origin } });
  await once(sender, 'open');
  const createdPromise = waitForMessage(sender, (message) => message.type === 'room-created');
  sender.send(JSON.stringify({ type: 'create-room', role: 'sender' }));
  const created = await createdPromise;

  const receiver = new WebSocket(wsUrl, { headers: { Origin: origin } });
  await once(receiver, 'open');
  const joinedPromise = waitForMessage(receiver, (message) => message.type === 'room-joined');
  const matchedPromise = waitForMessage(sender, (message) => message.type === 'matched');
  receiver.send(JSON.stringify({ type: 'join-room', role: 'receiver', token: created.token }));
  const joined = await joinedPromise;
  await matchedPromise;

  const peerReconnectingPromise = waitForMessage(receiver, (message) => message.type === 'peer-reconnecting');
  sender.close();
  await peerReconnectingPromise;

  const resumedSender = new WebSocket(wsUrl, { headers: { Origin: origin } });
  await once(resumedSender, 'open');
  const resumedPromise = waitForMessage(resumedSender, (message) => message.type === 'room-resumed');
  const peerReconnectedPromise = waitForMessage(receiver, (message) => message.type === 'peer-reconnected');
  resumedSender.send(JSON.stringify({
    type: 'resume-room',
    token: created.token,
    role: 'sender',
    sessionId: created.sessionId
  }));
  const resumed = await resumedPromise;
  assert.equal(resumed.matched, true);
  await peerReconnectedPromise;
  assert.ok(joined.sessionId);

  const signalPromise = waitForMessage(receiver, (message) => message.type === 'signal');
  const offer = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } };
  resumedSender.send(JSON.stringify({ type: 'signal', data: offer }));
  assert.deepEqual((await signalPromise).data, offer);

  const senderClosed = once(resumedSender, 'close');
  const receiverClosed = once(receiver, 'close');
  resumedSender.close();
  receiver.close();
  await Promise.all([senderClosed, receiverClosed]);
  assert.equal(child.exitCode, null, stderr);
});
