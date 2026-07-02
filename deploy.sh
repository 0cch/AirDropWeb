#!/bin/bash
set -e

# === P2P File Transfer 一键部署脚本 ===
# 适用于 Linux 服务器（Ubuntu/Debian/CentOS）
# 支持直接部署或 Nginx 反向代理 + HTTPS

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
NODE_REQUIRED="18"
DOMAIN="${DOMAIN:-}"
USE_NGINX="${USE_NGINX:-no}"
USE_HTTPS="${USE_HTTPS:-no}"

echo "=========================================="
echo "  P2P File Transfer 一键部署"
echo "=========================================="
echo "  应用目录: $APP_DIR"
echo "  监听端口: $PORT"
echo "  Nginx代理: $USE_NGINX"
if [ -n "$DOMAIN" ]; then echo "  域名: $DOMAIN"; fi
echo "  HTTPS: $USE_HTTPS"
echo "=========================================="
echo ""

# ========== 1. 检查/安装 Node.js ==========
if ! command -v node &> /dev/null; then
  echo "[1/6] 未检测到 Node.js，正在安装 Node.js $NODE_REQUIRED..."
  if command -v apt-get &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_$NODE_REQUIRED.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v yum &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_$NODE_REQUIRED.x | sudo bash -
    sudo yum install -y nodejs
  else
    echo "[ERROR] 无法自动安装 Node.js，请手动安装 Node.js >= $NODE_REQUIRED"
    exit 1
  fi
else
  echo "[1/6] Node.js $(node -v) 已安装"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt "$NODE_REQUIRED" ]; then
  echo "[ERROR] Node.js 版本过低 (当前 v$NODE_VERSION，需要 >= v$NODE_REQUIRED)"
  exit 1
fi

# ========== 2. 安装服务器依赖 ==========
echo ""
echo "[2/6] 安装服务器依赖..."
cd "$APP_DIR/server"
npm install --production

# ========== 3. 安装前端依赖并构建 ==========
echo ""
echo "[3/6] 安装前端依赖并构建..."
cd "$APP_DIR/client"
npm install
npm run build

# ========== 4. 配置防火墙 ==========
echo ""
echo "[4/6] 配置防火墙..."
if command -v ufw &> /dev/null; then
  sudo ufw allow $PORT/tcp 2>/dev/null || true
  if [ "$USE_NGINX" = "yes" ]; then
    sudo ufw allow 80/tcp 2>/dev/null || true
    sudo ufw allow 443/tcp 2>/dev/null || true
  fi
  echo "  [OK] ufw 已放行端口 $PORT"
elif command -v firewall-cmd &> /dev/null; then
  sudo firewall-cmd --permanent --add-port=$PORT/tcp 2>/dev/null || true
  if [ "$USE_NGINX" = "yes" ]; then
    sudo firewall-cmd --permanent --add-service=http 2>/dev/null || true
    sudo firewall-cmd --permanent --add-service=https 2>/dev/null || true
  fi
  sudo firewall-cmd --reload 2>/dev/null || true
  echo "  [OK] firewalld 已放行端口 $PORT"
else
  echo "  [SKIP] 未检测到防火墙工具，请手动放行端口 $PORT"
fi

# ========== 5. Nginx Reverse Proxy (Optional) ==========
if [ "$USE_NGINX" = "yes" ]; then
  echo ""
  echo "[5/6] Configuring Nginx reverse proxy..."
  if ! command -v nginx &> /dev/null; then
    echo "  Installing Nginx..."
    if command -v apt-get &> /dev/null; then
      sudo apt-get install -y nginx
    elif command -v yum &> /dev/null; then
      sudo yum install -y nginx
    fi
  fi

  SERVER_NAME="${DOMAIN:-_}"
  NGINX_CONF="/etc/nginx/sites-available/p2p-file-transfer"
  if [ ! -d "$(dirname $NGINX_CONF)" ]; then
    NGINX_CONF="/etc/nginx/conf.d/p2p-file-transfer.conf"
  fi

  if [ "$USE_HTTPS" = "yes" ] && [ -n "$DOMAIN" ]; then
    echo "  Setting up HTTPS (Let's Encrypt)..."
    if ! command -v certbot &> /dev/null; then
      if command -v apt-get &> /dev/null; then
        sudo apt-get install -y certbot python3-certbot-nginx
      elif command -v yum &> /dev/null; then
        sudo yum install -y certbot python3-certbot-nginx
      fi
    fi

    # Write HTTP config first, certbot will upgrade to HTTPS
    sudo tee "$NGINX_CONF" > /dev/null <<NGINXEOF
server {
    listen 80;
    server_name DOMAINPH;
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:PORTPH;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /ws {
        proxy_pass http://127.0.0.1:PORTPH;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
NGINXEOF
    sudo sed -i "s/DOMAINPH/$DOMAIN/g" "$NGINX_CONF"
    sudo sed -i "s/PORTPH/$PORT/g" "$NGINX_CONF"

    if [ -d /etc/nginx/sites-enabled ]; then
      sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/p2p-file-transfer
      sudo rm -f /etc/nginx/sites-enabled/default
    fi
    sudo nginx -t
    sudo systemctl reload nginx
    sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
  else
    # HTTP only reverse proxy
    sudo tee "$NGINX_CONF" > /dev/null <<NGINXEOF
server {
    listen 80;
    server_name SERVERPH;
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:PORTPH;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /ws {
        proxy_pass http://127.0.0.1:PORTPH;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
NGINXEOF
    sudo sed -i "s/SERVERPH/$SERVER_NAME/g" "$NGINX_CONF"
    sudo sed -i "s/PORTPH/$PORT/g" "$NGINX_CONF"

    if [ -d /etc/nginx/sites-enabled ]; then
      sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/p2p-file-transfer
      sudo rm -f /etc/nginx/sites-enabled/default
    fi
    sudo nginx -t
    sudo systemctl reload nginx
    sudo systemctl enable nginx
  fi
  echo "  [OK] Nginx configured"
else
  echo ""
  echo "[5/6] Skipping Nginx"
fi
# ========== 6. Systemd Service ==========
echo ""
echo "[6/6] Configuring systemd service..."

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
Environment=HOST=$HOST
ExecStart=$(which node) $APP_DIR/server/index.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

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
  echo "  Deployment SUCCESS!"
  echo "=========================================="
  if [ "$USE_NGINX" = "yes" ]; then
    if [ "$USE_HTTPS" = "yes" ] && [ -n "$DOMAIN" ]; then
      echo "  URL: https://$DOMAIN"
    else
      echo "  URL: http://<server-ip>"
    fi
  else
    echo "  URL: http://<server-ip>:$PORT"
  fi
  echo ""
  echo "  Commands:"
  echo "    status:  sudo systemctl status p2p-file-transfer"
  echo "    logs:    sudo journalctl -u p2p-file-transfer -f"
  echo "    restart: sudo systemctl restart p2p-file-transfer"
  echo "    stop:    sudo systemctl stop p2p-file-transfer"
  echo ""
  echo "  WebRTC ports:"
  echo "    TCP $PORT (signaling, opened)"
  echo "    UDP 49152-65535 (WebRTC media, STUN negotiated)"
  echo "    If P2P fails, check if UDP ports are blocked by firewall"
  echo "=========================================="
else
  echo ""
  echo "[ERROR] Service failed to start:"
  echo "  sudo journalctl -u p2p-file-transfer -e"
  exit 1
fi
