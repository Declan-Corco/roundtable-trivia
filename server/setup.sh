#!/usr/bin/env bash
# =============================================================================
#  Roundtable Trivia — one-command Linux installer
#
#  Usage (run from anywhere inside the project):
#     sudo bash server/setup.sh                         # interactive: asks for a domain
#     sudo bash server/setup.sh --domain trivia.example.com
#     sudo bash server/setup.sh --lan                   # no domain, local network only
#     sudo bash server/setup.sh --public-url https://trivia.example.com   # behind Cloudflare Tunnel etc.
#     sudo bash server/setup.sh --anthropic-key sk-ant-...   # turn on Claude check for Only One
#     sudo bash server/setup.sh --uninstall
#
#  What it does:
#   1. Installs Node.js (if missing or too old)
#   2. Copies the app to /opt/roundtable and installs its dependencies
#   3. Creates a "roundtable" system service that starts on boot and restarts on crash
#   4. (with a domain) Installs Caddy, which gets a free HTTPS certificate automatically
#   5. Opens the firewall ports
#
#  To update:  git pull && sudo bash server/setup.sh   (your settings are kept)
#  Supports Debian / Ubuntu / Raspberry Pi OS (apt) and Fedora / RHEL / Rocky / Alma (dnf).
# =============================================================================
set -euo pipefail

APP="roundtable"
INSTALL_DIR="/opt/roundtable"
ENV_FILE="/etc/roundtable.env"
SERVICE_FILE="/etc/systemd/system/roundtable.service"
NODE_MAJOR=22
MIN_NODE=22 # older Node is end-of-life, and sharp (used by the Only One matching model) needs 20.9+

DOMAIN=""
EMAIL=""
PUBLIC_URL_ARG=""
PORT_ARG=""
ANTHROPIC_KEY_ARG=""
MODE=""          # domain | lan | public-url (empty = ask)
UNINSTALL=0

c_bold=$'\e[1m'; c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'; c_cyan=$'\e[36m'; c_off=$'\e[0m'
step() { echo; echo "${c_cyan}${c_bold}==> $*${c_off}"; }
ok()   { echo "${c_green}  ✓ $*${c_off}"; }
warn() { echo "${c_yellow}  ! $*${c_off}"; }
die()  { echo "${c_red}${c_bold}  ✗ $*${c_off}" >&2; exit 1; }

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)      DOMAIN="${2:-}"; MODE="domain"; shift 2 ;;
    --email)       EMAIL="${2:-}"; shift 2 ;;
    --public-url)  PUBLIC_URL_ARG="${2:-}"; MODE="public-url"; shift 2 ;;
    --lan)         MODE="lan"; shift ;;
    --port)        PORT_ARG="${2:-}"; shift 2 ;;
    --anthropic-key) ANTHROPIC_KEY_ARG="${2:-}"; shift 2 ;;
    --uninstall)   UNINSTALL=1; shift ;;
    -h|--help)     usage ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

# Re-run with sudo if needed.
if [[ $EUID -ne 0 ]]; then
  echo "This installer needs administrator rights — re-running with sudo…"
  exec sudo bash "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(dirname "$SCRIPT_DIR")"

# ----------------------------------------------------------------------------- uninstall
if [[ $UNINSTALL -eq 1 ]]; then
  step "Uninstalling Roundtable Trivia"
  systemctl disable --now "$APP" 2>/dev/null || true
  rm -f "$SERVICE_FILE"; systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  rm -f "$ENV_FILE"
  id -u "$APP" &>/dev/null && userdel "$APP" || true
  ok "Removed the service, $INSTALL_DIR and $ENV_FILE."
  warn "Caddy and Node.js were left installed. Remove them with your package manager if you like."
  exit 0
fi

[[ -f "$SRC_ROOT/server/src/index.js" && -d "$SRC_ROOT/client" ]] \
  || die "Can't find the project files. Run this script from inside the project (it expects client/ and server/ next to each other)."

# ----------------------------------------------------------------------------- package manager
if command -v apt-get &>/dev/null; then PM="apt"
elif command -v dnf &>/dev/null; then PM="dnf"
else die "Unsupported Linux distribution (need apt or dnf). Install Node.js ${MIN_NODE}+ yourself, then run: cd server && npm install && npm start"
fi
command -v systemctl &>/dev/null || die "systemd is required."

pm_install() {
  if [[ $PM == apt ]]; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  else dnf install -y -q "$@" >/dev/null; fi
}

# ----------------------------------------------------------------------------- questions
CURRENT_PUBLIC_URL=""
[[ -f "$ENV_FILE" ]] && CURRENT_PUBLIC_URL="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2- || true)"

if [[ -z "$MODE" && -f "$ENV_FILE" ]]; then
  # Already installed: this is an update, so keep the existing settings without asking.
  MODE="keep"
  echo "Updating — keeping your current settings${CURRENT_PUBLIC_URL:+ (${CURRENT_PUBLIC_URL})}."
  echo "To change how players reach the server, re-run with --domain, --lan or --public-url."
fi

if [[ -z "$MODE" ]]; then
  if [[ -t 0 ]]; then
    echo
    echo "${c_bold}How will players reach this server?${c_off}"
    echo "  1) With my own domain name, e.g. trivia.example.com (sets up free HTTPS)"
    echo "  2) Only on my local network / Wi-Fi (no domain)"
    echo "  3) Through Cloudflare Tunnel or another proxy I set up myself"
    read -rp "Choose [1-3]: " choice
    case "$choice" in
      1) MODE="domain"; read -rp "Domain name (e.g. trivia.example.com): " DOMAIN
         read -rp "Email for HTTPS certificate notices (optional, Enter to skip): " EMAIL ;;
      2) MODE="lan" ;;
      3) MODE="public-url"; read -rp "Public URL players will use (e.g. https://trivia.example.com): " PUBLIC_URL_ARG ;;
      *) die "Please run again and pick 1, 2 or 3." ;;
    esac
  else
    MODE="keep"
  fi
fi

if [[ $MODE == domain ]]; then
  DOMAIN="$(echo "$DOMAIN" | sed -E 's#^https?://##; s#/.*$##' | tr 'A-Z' 'a-z')"
  [[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "\"$DOMAIN\" doesn't look like a domain name."
fi
if [[ $MODE == public-url ]]; then
  PUBLIC_URL_ARG="${PUBLIC_URL_ARG%/}"
  [[ "$PUBLIC_URL_ARG" =~ ^https?://[^/]+$ ]] || die "Public URL must look like https://trivia.example.com"
fi

# ----------------------------------------------------------------------------- Node.js
step "Checking Node.js"
need_node=1
if command -v node &>/dev/null; then
  have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( have >= MIN_NODE )); then need_node=0; ok "Node.js $(node -v) already installed"; fi
fi
if (( need_node )); then
  echo "  Installing Node.js ${NODE_MAJOR}…"
  if [[ $PM == apt ]]; then
    apt-get update -qq
    pm_install ca-certificates curl gnupg
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    pm_install nodejs
  else
    pm_install curl
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    pm_install nodejs
  fi
  ok "Installed Node.js $(node -v)"
fi
NODE_BIN="$(command -v node)"

# ----------------------------------------------------------------------------- app files
step "Installing the app to ${INSTALL_DIR}"
id -u "$APP" &>/dev/null || useradd --system --user-group --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$APP"
PACK_DIRS=(trivia onlyone) # question and category packs (see the README in each folder)
for d in "${PACK_DIRS[@]}"; do mkdir -p "$INSTALL_DIR/server/$d"; done

if [[ "$(realpath "$SRC_ROOT")" != "$(realpath "$INSTALL_DIR")" ]]; then
  rm -rf "$INSTALL_DIR/client" "$INSTALL_DIR/server/src"
  cp -r "$SRC_ROOT/client" "$INSTALL_DIR/client"
  cp -r "$SRC_ROOT/server/src" "$INSTALL_DIR/server/src"
  cp "$SRC_ROOT/server/package.json" "$INSTALL_DIR/server/"
  [[ -f "$SRC_ROOT/server/package-lock.json" ]] && cp "$SRC_ROOT/server/package-lock.json" "$INSTALL_DIR/server/"
  cp "$SRC_ROOT/server/setup.sh" "$INSTALL_DIR/server/"
  # Question packs: add/update the shipped ones, never delete packs you added on the server.
  for d in "${PACK_DIRS[@]}"; do
    if [[ -d "$SRC_ROOT/server/$d" ]]; then cp -r "$SRC_ROOT/server/$d/." "$INSTALL_DIR/server/$d/"; fi
  done
fi
mkdir -p "$INSTALL_DIR/server/trivia/media" "$INSTALL_DIR/server/data" # data/: the saved question bank

# Fix Windows line endings if the files were edited on Windows.
for d in "${PACK_DIRS[@]}"; do
  find "$INSTALL_DIR/server/$d" -name '*.json' -exec sed -i 's/\r$//' {} + 2>/dev/null || true
done

# Sample trivia sets from older versions (Trivia now uses Open Trivia DB). Each is removed only if
# it's exactly as shipped, so a sample you edited is kept.
RETIRED_SAMPLES=(
  "general-knowledge.json be42a634aa274798c078f5b25bb1bdc50be73fed019dc535e9a69c550b66abf9"
  "geography.json 27b3ad9f78d6a1411958e7f369139995b091e2266631c29fe2d7ac34fed3701a"
  "science.json cd7163ccf0b07118984fd0e9c50d299e09a97e0bfed31b260b3faa894b8a2e9f"
)
for entry in "${RETIRED_SAMPLES[@]}"; do
  f="$INSTALL_DIR/server/trivia/${entry%% *}"
  if [[ -f "$f" && "$(sha256sum "$f" | cut -c1-64)" == "${entry##* }" ]]; then rm -f "$f"; fi
done

echo "  Installing dependencies (npm)…"
cd "$INSTALL_DIR/server"
if [[ -f package-lock.json ]]; then npm ci --omit=dev --no-audit --no-fund --loglevel=error
else npm install --omit=dev --no-audit --no-fund --loglevel=error; fi
chown -R "$APP:$APP" "$INSTALL_DIR"
ok "App files installed"

# ----------------------------------------------------------------------------- settings file
step "Writing settings to ${ENV_FILE}"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'EOF'
# Roundtable Trivia settings. After editing run:  sudo systemctl restart roundtable
PORT=3000
HOST=0.0.0.0
# Address used in the join QR code. Empty = detect automatically.
PUBLIC_URL=
# Set a password to stop strangers from creating games on a public server.
HOST_PASSWORD=
# Allow hosts to upload their own trivia .json file from the host screen.
ALLOW_UPLOADS=true
MAX_PLAYERS=200
# iOS app (optional): lets the Camera open join QR codes straight in the app.
# Set to YOURTEAMID.site.round-table.app once the app is signed with a paid Apple Developer account.
APPLE_APP_ID=
# Only One (optional): Claude double-checks each round's answers when this is set.
# Get a key at https://console.anthropic.com. About $0.0003 per round; answers are sent to Anthropic.
ANTHROPIC_API_KEY=
EOF
  chmod 640 "$ENV_FILE"
  chgrp "$APP" "$ENV_FILE"
fi

set_env() { # set_env KEY VALUE
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
[[ -n "$PORT_ARG" ]] && set_env PORT "$PORT_ARG"
[[ -n "$ANTHROPIC_KEY_ARG" ]] && set_env ANTHROPIC_API_KEY "$ANTHROPIC_KEY_ARG"
case "$MODE" in
  domain)     set_env PUBLIC_URL "https://$DOMAIN" ;;
  public-url) set_env PUBLIC_URL "$PUBLIC_URL_ARG" ;;
  lan)        set_env PUBLIC_URL "" ;;
esac
PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2- || true)"; PORT="${PORT:-3000}"
ok "Settings saved"

# ----------------------------------------------------------------------------- systemd service
step "Creating the background service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Roundtable Trivia game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP}
Group=${APP}
WorkingDirectory=${INSTALL_DIR}/server
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$APP" >/dev/null 2>&1
systemctl restart "$APP"

for i in {1..20}; do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  ok "Service is running (starts automatically on boot)"
else
  journalctl -u "$APP" -n 30 --no-pager || true
  die "The service did not start. See the log above."
fi

# ----------------------------------------------------------------------------- Caddy (HTTPS)
if [[ $MODE == domain ]]; then
  step "Setting up HTTPS for ${DOMAIN} with Caddy"
  if ! command -v caddy &>/dev/null; then
    if [[ $PM == apt ]]; then
      pm_install debian-keyring debian-archive-keyring apt-transport-https curl gnupg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq
      pm_install caddy
    else
      dnf install -y -q 'dnf-command(copr)' >/dev/null
      dnf copr enable -y @caddy/caddy >/dev/null
      pm_install caddy
    fi
    ok "Installed Caddy"
  fi

  CADDYFILE=/etc/caddy/Caddyfile
  if [[ -f $CADDYFILE ]] && ! grep -q "Roundtable Trivia" "$CADDYFILE"; then
    cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
    warn "Backed up your existing Caddyfile to $CADDYFILE.bak.*"
  fi
  {
    echo "# Roundtable Trivia — generated by setup.sh"
    if [[ -n "$EMAIL" ]]; then printf '{\n\temail %s\n}\n\n' "$EMAIL"; fi
    printf '%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT"
  } > "$CADDYFILE"
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || die "Caddyfile is invalid — check $CADDYFILE"
  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy
  ok "Caddy is serving https://${DOMAIN} (certificate is requested automatically)"
fi

# ----------------------------------------------------------------------------- firewall
step "Opening firewall ports"
if [[ $MODE == domain ]]; then PORTS=(80 443); else PORTS=("$PORT"); fi
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  for p in "${PORTS[@]}"; do ufw allow "$p/tcp" >/dev/null; done
  ok "ufw: allowed ${PORTS[*]}"
elif command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
  for p in "${PORTS[@]}"; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
  firewall-cmd --reload >/dev/null
  ok "firewalld: allowed ${PORTS[*]}"
else
  ok "No active firewall detected — nothing to do"
fi

# ----------------------------------------------------------------------------- summary
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
FINAL_URL="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2- || true)"

echo
echo "${c_green}${c_bold}=====================================================${c_off}"
echo "${c_green}${c_bold}  Roundtable Trivia is installed and running!${c_off}"
echo "${c_green}${c_bold}=====================================================${c_off}"
[[ -n "$LAN_IP" ]] && echo "  On your network:  ${c_bold}http://${LAN_IP}:${PORT}/host${c_off}"
[[ -n "$FINAL_URL" ]] && echo "  Public address:   ${c_bold}${FINAL_URL}/host${c_off}"
echo
echo "  Trivia sets:   ${INSTALL_DIR}/server/trivia/    (drop .json files here)"
echo "  Only One packs: ${INSTALL_DIR}/server/onlyone/"
echo "  Settings:      ${ENV_FILE}"
if grep -qE '^ANTHROPIC_API_KEY=.+' "$ENV_FILE"; then echo "  Claude check:  on for Only One"
else echo "  Claude check:  off (add --anthropic-key sk-ant-... to turn it on)"; fi
echo "  View logs:     sudo journalctl -u ${APP} -f"
echo "  Restart:       sudo systemctl restart ${APP}"
echo "  Update:        re-run this script after changing the project files"

if [[ $MODE == domain ]]; then
  PUB_IP="$(curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  echo
  if [[ -z "$DNS_IP" ]]; then
    warn "${DOMAIN} doesn't resolve yet. Add a DNS 'A' record pointing to ${PUB_IP:-your public IP}."
  elif [[ -n "$PUB_IP" && "$DNS_IP" != "$PUB_IP" ]]; then
    warn "${DOMAIN} points to ${DNS_IP}, but this machine's public IP is ${PUB_IP}."
    warn "Fix the DNS 'A' record (ignore this if you use a proxy such as Cloudflare's orange cloud)."
  else
    ok "DNS for ${DOMAIN} points to this machine (${DNS_IP})"
  fi
  echo "  Remember to forward ports 80 and 443 on your router to ${LAN_IP:-this machine}."
  echo "  HTTPS can take a minute the first time. Check with: sudo journalctl -u caddy -f"
fi
if ! grep -qE '^HOST_PASSWORD=.+' "$ENV_FILE" && [[ -n "$FINAL_URL" ]]; then
  echo
  warn "Your server is public but has no host password. Anyone could create games."
  warn "Set HOST_PASSWORD in ${ENV_FILE}, then: sudo systemctl restart ${APP}"
fi
echo
