# AirDrop Web — P2P 文件传输

外网部署的浏览器文件传输站。用户通过 8 位 Token 配对，WebRTC DataChannel 优先直连，无法直连时可回退到 TURN 加密中继。服务器只负责 HTTP/WSS 信令、WebRTC ICE 配置和房间管理，不保存文件。

## 特性

- WebRTC 端到端加密传输，优先 P2P 直连
- 分享链接、二维码和系统分享，接收方可直接打开链接加入
- 接收方可使用应用内摄像头扫码，失败后自动回退到手动输入
- 多文件队列：一次确认、逐文件传输、总进度与单文件状态
- 可选 TURN/TURNS 中继，覆盖对称 NAT、企业网络等场景
- Chromium 浏览器支持 File System Access API 流式落盘，大文件不必全部进入内存
- 多文件在 Chromium 中可选择一次保存目录，文件按队列顺序写入
- 其他浏览器自动使用内存模式，默认整批文件总大小上限 256 MB
- 文件元信息、流控、完成 ACK、错误与取消控制消息
- 支持暂停/继续、取消确认和单文件失败重试
- 信令短暂断开后会在恢复窗口内重新绑定原房间
- DataChannel 断开后自动重新协商，并从接收端最后写入位置续传
- 显示局域网直连、公网直连或 TURN 中继等实际连接路径
- 移动端支持屏幕常亮、分享链接和安全区域布局
- 64 KB 分块、DataChannel 背压与接收端写入信用窗口
- ICE candidate 排队、连接超时、传输超时与明确错误提示
- 一次性房间、角色冲突检测、Origin 校验、连接与消息速率限制
- CSP、安全响应头、异步静态文件服务和长期缓存
- Node.js 内置测试、TypeScript 检查和 GitHub Actions CI

## 快速开始

要求 Node.js 22 或更高版本。

```bash
npm ci
npm run dev
```

浏览器打开 <http://localhost:5174>。Vite 会将 `/ws` 和 `/api` 代理到 `http://localhost:8080`。

常用命令：

```bash
npm run typecheck   # TypeScript 检查
npm test            # 信令服务回归测试
npm run build       # 构建前端
npm run audit:prod  # 检查生产依赖漏洞
npm start           # 启动生产信令服务
```

## 使用流程

1. 发送方点击“发送文件”，获得 Token、分享链接和二维码
2. 接收方扫描二维码、打开分享链接，或手动输入 Token
3. 配对后，发送方可以一次选择多个文件
4. 接收方确认整个队列并选择保存位置或目录
5. 文件按顺序传输，支持暂停、继续和单文件失败重试
6. 全部文件完成并校验后，发送方才会显示“对方已确认接收完成”

## 公网部署

```bash
chmod +x deploy.sh
DOMAIN=example.com USE_NGINX=yes USE_HTTPS=yes ./deploy.sh
```

直接以 Node.js 对外提供服务：

```bash
PORT=8080 ./deploy.sh
```

部署脚本会安装 Node.js 22+、安装 workspace 依赖、构建前端、配置防火墙和 systemd。Nginx 模式下应用默认只监听 `127.0.0.1`，服务器只需暴露 80/443，不会额外公开内部 8080 端口。

### 可选 TURN 配置

生产环境建议部署 coturn，并使用短期 HMAC 凭据。服务端支持 coturn REST API 风格的动态凭据：

```bash
TURN_URLS="turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp" \
TURN_SECRET="replace-with-a-long-random-secret" \
TURN_REQUIRED=1 \
DOMAIN=example.com USE_NGINX=yes USE_HTTPS=yes ./deploy.sh
```

可直接复用的 coturn Docker Compose 模板位于 `deploy/coturn/`。

对应的 coturn 配置示例：

```conf
use-auth-secret
static-auth-secret=replace-with-a-long-random-secret
realm=turn.example.com
listening-port=3478
tls-listening-port=5349
min-port=49160
max-port=49200
fingerprint
no-multicast-peers
```

同时在防火墙中仅开放 coturn 实际使用的端口。TURN 会产生服务器带宽成本，公开服务应增加带宽配额与监控。

也可以使用固定凭据，但只建议内网测试：

```bash
TURN_URLS="turn:turn.example.com:3478" \
TURN_USERNAME="airdrop" \
TURN_CREDENTIAL="strong-password" \
./deploy.sh
```

## 服务端环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WSS 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；Nginx 模式建议 `127.0.0.1` |
| `NODE_ENV` | 未设置 | 生产环境设为 `production`，启用严格 Origin 规则 |
| `ALLOWED_ORIGINS` | 同源 | 逗号分隔的额外允许 Origin |
| `TRUST_PROXY` | `0` | 位于可信反向代理后时设为 `1` |
| `ROOM_TTL_MS` | `600000` | 未配对房间有效期 |
| `ROOM_RESUME_GRACE_MS` | `45000` | WebSocket 断开后的房间恢复窗口 |
| `MAX_ROOMS` | `500` | 全局房间上限 |
| `MAX_CLIENTS` | `1000` | WebSocket 连接上限 |
| `MAX_CONNECTIONS_PER_MINUTE` | `60` | 单 IP 每分钟建连上限 |
| `MAX_CONCURRENT_CONNECTIONS_PER_IP` | `20` | 单 IP 并发 WebSocket 上限 |
| `MESSAGE_RATE_PER_SECOND` | `40` | 单连接消息速率 |
| `MAX_SIGNAL_BYTES` | `262144` | 单条信令消息大小上限 |
| `STUN_URLS` | 内置公共 STUN | 逗号分隔的 STUN 地址 |
| `TURN_URLS` | 空 | 逗号分隔的 TURN/TURNS 地址 |
| `TURN_SECRET` | 空 | 生成短期 TURN 凭据的共享密钥 |
| `TURN_TTL_SECONDS` | `3600` | 短期 TURN 凭据有效期 |
| `TURN_REQUIRED` | `0` | 设为 `1` 时，TURN 配置无效将拒绝启动 |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | 空 | 固定 TURN 凭据，仅建议测试 |

`/api/ice-config` 会向浏览器返回 STUN/TURN 配置，TURN 动态用户名和密码不会写死在静态构建产物中。

## 传输限制

- 流式落盘依赖 File System Access API，目前主要支持 Chromium 桌面浏览器
- Firefox、Safari 或不支持文件选择器的环境使用内存模式，整批文件总大小上限 256 MB
- 多文件目录落盘依赖 File System Access API，目前主要支持 Chromium 桌面浏览器
- 接收端必须在应用内点击“选择位置并接收”，这是浏览器要求用户手势才能打开文件保存选择器的安全限制
- 文件队列最多 100 个文件；单个会话内的批次会按顺序传输
- 纯 P2P 无法覆盖所有 NAT 组合，生产环境应配置 TURN

## 自动化测试

项目包含 Vitest、Node.js 回归测试和 Playwright 跨浏览器端到端测试：

```bash
npm test
npm run test:e2e
npm run test:e2e:chromium
```

首次运行 Playwright 前执行 `npx playwright install chromium firefox webkit`。

Playwright 覆盖多文件传输、目录落盘、磁盘错误重试、信令恢复、DataChannel 恢复、扫码权限降级和分享链接预填。

## 安全设计

- Token 使用 Node.js `crypto.randomInt()` 生成
- 房间每个角色最多一个连接，一个 WebSocket 只能加入一个房间
- 生产环境校验 WebSocket Origin；可配置允许来源
- 限制单 IP 建连、单连接消息速率、全局连接数和房间数
- 信令消息执行结构和大小校验，HTTP URL 解码与静态路径错误不会导致进程退出
- 静态路径通过 `path.relative()` 校验，防止目录穿越
- 默认启用 CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 等响应头
- WebRTC DataChannel 使用 DTLS 加密；Token 仍应通过可信渠道分享

## 架构

```text
发送方浏览器 ── WSS 信令 ──┐
                           ├── Node.js 信令服务器
接收方浏览器 ── WSS 信令 ──┘
      │
      └── WebRTC DataChannel：优先直连，必要时经 TURN 中继
```

信令服务器不接收文件内容。配置 TURN 时，只有在 WebRTC 直连失败后，加密后的文件流量才会经过 TURN 服务器。

## License

MIT
