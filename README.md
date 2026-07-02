# AirDrop Web — P2P 文件传输

外网部署的网站，让用户通过 Token 配对，使用 WebRTC 数据通道实现文件 P2P 直连传输。文件数据不经过服务器，服务器仅负责信令交换。

## 特性

- P2P 直连 — 文件数据通过 WebRTC 直接在两台设备间传输，不经过服务器
- 苹果风格 UI — 毛玻璃、留白、SF Pro 字体
- Token 配对 — 8 位随机码，自动生成，角色冲突检测
- NAT 穿透 — 优先同局域网直连，公网通过 Google STUN 穿透
- 安全 — 一次性 Token，WebRTC DTLS 加密，路径穿越防护
- 自动重连 — WebSocket 断线指数退避重连
- 心跳检测 — 服务端 30 秒心跳保活

## 快速开始（开发模式）

```bash
# 终端 1：启动信令服务器
cd server
npm install
node index.js

# 终端 2：启动前端开发服务器
cd client
npm install
npx vite --port 5174
```

浏览器打开 http://localhost:5174

## 公网部署（Linux 服务器）

### 方式一：直接部署（HTTP）

```bash
git clone <repo-url> p2p-file-transfer
cd p2p-file-transfer
chmod +x deploy.sh
./deploy.sh
```

默认端口 8080，自定义端口：`PORT=3000 ./deploy.sh`

### 方式二：Nginx 反向代理（HTTP）

```bash
USE_NGINX=yes ./deploy.sh
```

Nginx 监听 80 端口，反代到内部 8080。

### 方式三：Nginx + HTTPS（推荐生产环境）

```bash
DOMAIN=your-domain.com USE_NGINX=yes USE_HTTPS=yes ./deploy.sh
```

自动申请 Let's Encrypt SSL 证书，配置 HTTPS + WSS。

> **重要**：公网部署必须使用 HTTPS，否则浏览器会阻止 WebRTC 和 WebSocket（混合内容拦截）。

### 部署脚本自动完成

1. 检测/安装 Node.js 18+
2. 安装服务器依赖
3. 构建前端静态文件
4. 配置防火墙（ufw / firewalld）
5. 配置 Nginx 反向代理 + HTTPS（可选）
6. 创建 systemd 服务，开机自启 + 崩溃自动重启

## 使用流程

1. 用户 A 打开网站 → 点"发送文件" → 获得系统生成的 8 位 Token
2. 用户 A 将 Token 通过任意渠道告诉用户 B
3. 用户 B 打开网站 → 点"接收文件" → 输入 Token → 连接
4. 配对成功 → A 拖入文件 → B 自动接收并下载

## 架构

```
用户A 浏览器 ←── WebSocket/WSS 信令 ──→ 公网服务器 (Node.js + ws)
    │                                       │
    │      WebRTC DataChannel (P2P)          │
    │  ← 文件数据直接传输，不经过服务器 →       │
    │                                       │
用户B 浏览器 ←── WebSocket/WSS 信令 ──→ STUN (Google 公共)
```

服务器仅负责：Token 房间管理 + WebRTC 信令转发（SDP/ICE），不触碰任何文件数据。

## 公网部署注意事项

- **HTTPS 必需**：公网环境下浏览器要求 HTTPS 页面才能使用 WebRTC 和 WSS
- **UDP 端口**：WebRTC 需要 UDP 49152-65535 范围端口，确保防火墙未拦截
- **STUN 限制**：Google 公共 STUN 对对称型 NAT 可能失败，如需 100% 覆盖需自建 TURN
- **WebSocket 超时**：Nginx 配置了 `proxy_read_timeout 86400` 防止长连接被断开

## 常用运维命令

```bash
sudo systemctl status p2p-file-transfer    # 查看状态
sudo systemctl restart p2p-file-transfer   # 重启服务
sudo journalctl -u p2p-file-transfer -f    # 查看日志
```

## 技术栈

- 信令服务器：Node.js + ws
- 前端：React + Vite + TypeScript
- 样式：Tailwind CSS
- P2P：WebRTC DataChannel

## License

MIT
