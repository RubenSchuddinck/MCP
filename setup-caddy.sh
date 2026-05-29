#!/bin/bash
set -e

DOMAIN=""
UPSTREAM="localhost:3000"

usage() {
  echo "Usage: $0 -d <domain> [-u <upstream>]"
  echo "  -d  Domain name (required), e.g. mcp.example.com"
  echo "  -u  Upstream address (default: localhost:3000)"
  exit 1
}

while getopts "d:u:" opt; do
  case $opt in
    d) DOMAIN="$OPTARG" ;;
    u) UPSTREAM="$OPTARG" ;;
    *) usage ;;
  esac
done

[ -z "$DOMAIN" ] && usage

echo "==> Installing Caddy..."
CADDY_VERSION=$(curl -s https://api.github.com/repos/caddyserver/caddy/releases/latest | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')

curl -fsSL "https://github.com/caddyserver/caddy/releases/latest/download/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" -o /tmp/caddy.tar.gz
sudo tar xzf /tmp/caddy.tar.gz -C /tmp caddy
sudo mv /tmp/caddy /usr/local/bin/caddy
sudo chmod +x /usr/local/bin/caddy
rm /tmp/caddy.tar.gz

echo "==> Creating caddy user..."
sudo useradd --system --no-create-home --shell /sbin/nologin caddy 2>/dev/null || true

echo "==> Setting up directories..."
sudo mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
sudo chown caddy:caddy /var/lib/caddy /var/log/caddy

echo "==> Writing Caddyfile..."
sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
${DOMAIN} {
    reverse_proxy ${UPSTREAM}

    log {
        output file /var/log/caddy/access.log
    }
}
EOF

echo "==> Creating systemd service..."
sudo tee /etc/systemd/system/caddy.service > /dev/null <<EOF
[Unit]
Description=Caddy HTTP/2 web server
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
Environment=HOME=/var/lib/caddy

[Install]
WantedBy=multi-user.target
EOF

echo "==> Starting Caddy..."
sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl start caddy

echo ""
echo "Done! Caddy is running at https://${DOMAIN}"
echo "Proxying to ${UPSTREAM}"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status caddy"
echo "  sudo journalctl -u caddy -f"
echo "  sudo caddy reload --config /etc/caddy/Caddyfile"
