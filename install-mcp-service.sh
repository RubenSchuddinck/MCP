#!/bin/bash
set -e

# Installs the MCP server as a systemd service and grants the narrow
# passwordless-sudo rules the server needs for sync_caddy and restart_self.
#
# Usage: ./install-mcp-service.sh
#   BASE_URL env overrides the public URL (default below).

SERVICE=mcp
USER_NAME="$(whoami)"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node)"
SYSTEMCTL="$(command -v systemctl)"
CP_BIN="$(command -v cp)"
BASE_URL="${BASE_URL:-https://rubenplex.duckdns.org}"

[ -z "$NODE_BIN" ] && { echo "node not found on PATH"; exit 1; }

echo "==> Service:  $SERVICE"
echo "==> User:     $USER_NAME"
echo "==> Repo:     $REPO_DIR"
echo "==> Node:     $NODE_BIN"
echo "==> BASE_URL: $BASE_URL"

echo "==> Building..."
npm install
npm run build

echo "==> Writing /etc/systemd/system/${SERVICE}.service"
sudo tee /etc/systemd/system/${SERVICE}.service > /dev/null <<EOF
[Unit]
Description=MCP server
After=network.target

[Service]
WorkingDirectory=${REPO_DIR}
ExecStart=${NODE_BIN} ${REPO_DIR}/build/index.js
Environment=BASE_URL=${BASE_URL}
Restart=always
RestartSec=2
User=${USER_NAME}

[Install]
WantedBy=multi-user.target
EOF

echo "==> Writing /etc/sudoers.d/${SERVICE} (restart + caddy sync)"
sudo tee /etc/sudoers.d/${SERVICE} > /dev/null <<EOF
${USER_NAME} ALL=(root) NOPASSWD: ${SYSTEMCTL} restart --no-block ${SERVICE}, ${SYSTEMCTL} restart ${SERVICE}, ${SYSTEMCTL} reload caddy, ${CP_BIN} * /etc/caddy/Caddyfile
EOF
sudo chmod 440 /etc/sudoers.d/${SERVICE}
sudo visudo -cf /etc/sudoers.d/${SERVICE}

echo "==> Enabling + starting"
sudo ${SYSTEMCTL} daemon-reload
sudo ${SYSTEMCTL} enable --now ${SERVICE}
echo ""
sudo ${SYSTEMCTL} status ${SERVICE} --no-pager -l | head -12

echo ""
echo "Done. Manage with:"
echo "  sudo systemctl status ${SERVICE}"
echo "  sudo journalctl -u ${SERVICE} -f"
echo "  sudo systemctl restart ${SERVICE}    # or call the restart_self MCP tool"
