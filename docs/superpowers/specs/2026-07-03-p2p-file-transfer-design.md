# P2P 文件传输网站设计文档

**日期：** 2026-07-03
**状态：** 已确认

## 概述

外网部署的网站，让内网用户通过 token 配对，使用 WebRTC 数据通道实现文件 P2P 直连传输。文件数据不经过服务器，服务器仅负责信令交换。UI 采用苹果风格。

## 架构

```
用户A 浏览器  ←── WebSocket 信令 ──→  公网服务器 (Node.js+ws)
    │                                    │
    │     WebRTC DataChannel (P2P)       │
    │  ← 文件数据直接传输 →               │
    │                                    │
用户B 浏览器  ←── WebSocket 信令 ──→  STUN (Google 公共)
```

### 核心流程

1. 用户打开网站 → 选择"发送"或"接收" → 服务器生成 8 位 token 并建立房间
2. 对方输入 token + 选相反角色 → 服务器校验角色冲突，配对成功通知双方
3. 配对成功 → 双方通过服务器交换 WebRTC SDP/ICE 候选
4. WebRTC DataChannel 建立后 → 服务器退出信令，文件直接 P2P 传输
5. 任一方断开 → token 失效，房间销毁

### 服务器职责

极简：仅 token 房间管理 + WebRTC 信令转发，不触碰任何文件数据。

## 配对模型

- 系统自动生成 token（8 位大小写字母+数字，约 2 万亿种组合）
- 第一个用户选择"发送"或"接收"，获得系统生成的 token
- 第二个用户输入 token 并选相反角色
- 角色冲突（双方相同）→ 拒绝并提示"该 token 已有发送方/接收方在等待，请选择相反角色"
- 单房间最多 2 人

## 安全

- 8 位 token 不可猜测
- 房间一次性使用，连接建立或任一方断开后 token 失效
- WebRTC 自带 DTLS 加密

## NAT 穿透策略

1. 优先 host candidate（同局域网直接连通）
2. 配置 Google 公共 STUN（stun:stun.l.google.com:19302）作为公网穿透 fallback
3. 对称型 NAT 下可能失败，但内网用户场景通常 NAT 友好

## 技术栈

- **信令服务器：** Node.js + ws
- **前端：** React + Vite + TypeScript
- **样式：** Tailwind CSS
- **P2P：** WebRTC DataChannel

## 功能模块

### 前端页面（单页应用，3 个视图状态）

**首页：**
- 大标题 + 两个卡片按钮："发送文件"、"接收文件"
- 苹果风格留白与毛玻璃

**发送流程：**
1. 点"发送"→ 显示生成的 token（大字号、一键复制）+ "等待接收方连接..."状态
2. 配对成功 → 进入文件选择区，拖拽或点击选文件 → 显示传输进度条
3. 传输完成 → 显示成功状态，可选择继续发送或结束

**接收流程：**
1. 点"接收"→ 输入 token → 等待连接
2. 配对成功 → 显示对方发送的文件名、大小，自动开始接收 → 显示下载进度
3. 接收完成 → 自动触发浏览器下载到本地

### 信令服务器（3 个核心功能）

- `create-room` — 生成 token + 角色绑定，存入内存 Map
- `join-room` — 校验 token + 角色冲突检测，配对成功通知双方
- `signal` — 透传 SDP offer/answer 和 ICE candidate

### WebRTC 层

- 优先 host candidate（同局域网直接连通）
- 配置 Google STUN 作为公网穿透 fallback
- DataChannel 分块传输（每块 16KB），带进度回调
- 文件元信息（文件名、大小、类型）通过 DataChannel 先于数据发送

## 苹果风格 UI 规范

- **配色：** 白底为主（#ffffff / #f5f5f7），主色系统蓝（#0071e3），文字深灰（#1d1d1f）+ 次级灰（#6e6e73）
- **字体：** SF Pro Display / -apple-system 字体栈，大标题 semibold，正文 regular
- **圆角：** 卡片 20px，按钮 12px，输入框 10px
- **毛玻璃：** 关键卡片用 backdrop-blur + 半透明白底
- **动效：** 过渡 ease 0.3s，按钮 hover 轻微缩放，状态切换淡入淡出
- **留白：** 大量留白，内容居中，最大宽度 480px 窄栏布局，类似 AirDrop 简洁感
