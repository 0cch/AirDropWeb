# AirDrop Web — P2P 文件传输

外网部署的网站，让用户通过 Token 配对，使用 WebRTC 数据通道实现文件 P2P 直连传输。文件数据不经过服务器，服务器仅负责信令交换。

## 特性

- 🔒 **P2P 直连** — 文件数据通过 WebRTC 直接在两台设备间传输，不经过服务器
- 🍎 **苹果风格 UI** — 毛玻璃、留白、SF Pro 字体
- 🎫 **Token 配对** — 8 位随机码，自动生成，角色冲突检测
- 🌐 **NAT 穿透** — 优先同局域网直连，公网通过 STUN 穿透
- 🔐 **安全** — 一次性 Token，WebRTC DTLS 加密

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

浏览器打开 `http://localhost:5174`

## 一键部署（Linux 服务器）

```bash
# 克隆仓库到服务器
git clone <repo-url> p2p-file-transfer
cd p2p-file-transfer

# 赋予执行权限并运行
chmod +x deploy.sh
./deploy.sh
```

脚本会自动：
1. 检测/安装 Node.js 18+
2. 安装服务器依赖
3. 构建前端静态文件
4. 配置 systemd 服务并启动

默认端口 `8080`，可通过环境变量修改：`PORT=3000 ./deploy.sh`

## 使用流程

1. 用户 A 打开网站 → 点"发送文件" → 获得系统生成的 8 位 Token
2. 用户 A 将 Token 通过任意渠道告诉用户 B
3. 用户 B 打开网站 → 点"接收文件" → 输入 Token → 连接
4. 配对成功 → A 拖入文件 → B 自动接收并下载

## 架构

```
用户A 浏览器 ←── WebSocket 信令 ──→ 公网服务器 (Node.js + ws)
    │                                    │
    │     WebRTC DataChannel (P2P)       │
    │  ← 文件数据直接传输，不经过服务器 →    │
    │                                    │
用户B 浏览器 ←── WebSocket 信令 ──→ STUN (Google 公共)
```

服务器仅负责：Token 房间管理 + WebRTC 信令转发（SDP/ICE），不触碰任何文件数据。

## 技术栈

- **信令服务器：** Node.js + ws
- **前端：** React + Vite + TypeScript
- **样式：** Tailwind CSS
- **P2P：** WebRTC DataChannel

## 常用运维命令

```bash
sudo systemctl status p2p-file-transfer    # 查看状态
sudo systemctl restart p2p-file-transfer   # 重启服务
sudo journalctl -u p2p-file-transfer -f    # 查看日志
```

## License

MIT
