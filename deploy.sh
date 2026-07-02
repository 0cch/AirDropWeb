#!/bin/bash
set -e

# === P2P File Transfer 一键部署脚本 ===
# 适用于 Linux 服务器（Ubuntu/Debian/CentOS）

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8080}"
NODE_REQUIRED="18"

echo "=========================================="
echo "  P2P File Transfer 一键部署"
echo "=========================================="

# 检查 Node.js
if ! command -v node &> /dev/null; then
  echo "[ERROR] 未检测到 Node.js，正在安装 Node.js $NODE_REQUIRED..."
  if command -v apt-get &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_$NODE_REQUIRED.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v yum &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_$NODE_REQUIRED.x | sudo bash -
    sudo yum install -y nodejs
  else
    echo "[ERROR] 无法自动安装 Node.js，请手动安装 Node.js >= $NODE_REQUIRED 后重试"
    exit 1
  fi
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt "$NODE_REQUIRED" ]; then
  echo "[ERROR] Node.js 版本过低 (当前 v$NODE_VERSION，需要 >= v$NODE_REQUIRED)"
  exit 1
fi

echo "[OK] Node.js $(node -v)"

# 安装服务器依赖
echo ""
echo "[1/4] 安装服务器依赖..."
cd "$APP_DIR/server"
npm install --production

# 安装前端依赖并构建
echo ""
echo "[2/4] 安装前端依赖..."
cd "$APP_DIR/client"
npm install

echo ""
echo "[3/4] 构建前端..."
npm run build

echo ""
echo "[4/4] 配置 systemd 服务..."

SERVICE_FILE="/etc/systemd/system/p2p-file-transfer.service"
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=P2P File Transfer Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR/server
Environment=PORT=$PORT
ExecStart=$(which node) $APP_DIR/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable p2p-file-transfer
sudo systemctl restart p2p-file-transfer

sleep 2

if systemctl is-active --quiet p2p-file-transfer; then
  echo ""
  echo "=========================================="
  echo "  ✅ 部署成功！"
  echo "=========================================="
  echo "  服务地址: http://localhost:$PORT"
  echo ""
  echo "  常用命令:"
  echo "    查看状态: sudo systemctl status p2p-file-transfer"
  echo "    查看日志: sudo journalctl -u p2p-file-transfer -f"
  echo "    重启服务: sudo systemctl restart p2p-file-transfer"
  echo "    停止服务: sudo systemctl stop p2p-file-transfer"
  echo ""
  echo "  如需修改端口，编辑服务文件中的 PORT 环境变量后重启"
  echo "=========================================="
else
  echo ""
  echo "[ERROR] 服务启动失败，请查看日志："
  echo "  sudo journalctl -u p2p-file-transfer -e"
  exit 1
fi
