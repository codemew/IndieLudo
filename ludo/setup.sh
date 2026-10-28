#!/usr/bin/env bash
# Prepares a fresh machine to host the Ludo server:
#   Node.js (>= 22.13, installs 24 LTS if missing) → npm dependencies → config.json with
#   real passwords → production build → optional firewall rule, tests and systemd service.
#
# Works on Debian/Ubuntu/Raspberry Pi OS, Fedora/RHEL, Arch, openSUSE, Alpine, macOS and
# Android (Termux). Safe to run again: every step checks before it changes anything.
#
# Usage: ./setup.sh [--yes] [--service] [--test] [--skip-build] [--help]

set -euo pipefail

NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13 # first release with node:sqlite unflagged
NODE_INSTALL_MAJOR=24
NVM_VERSION=v0.40.3

ASSUME_YES=0
INSTALL_SERVICE=0
RUN_TESTS=0
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: ./setup.sh [options]

  --yes, -y      Don't ask questions: generate random passwords, skip the firewall prompt.
  --service      Install a systemd user service so the server starts on boot (Linux).
  --test         Run the test suite after building.
  --skip-build   Install and configure only; don't build.
  --help, -h     Show this help.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=1 ;;
    --service) INSTALL_SERVICE=1 ;;
    --test) RUN_TESTS=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"
APP_DIR="$(pwd)"

# Non-interactive when there is no terminal to ask on.
if [[ ! -t 0 ]]; then ASSUME_YES=1; fi

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' RESET=$'\e[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' RESET=''
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '%s  ✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '%s  ! %s%s\n' "$YELLOW" "$1" "$RESET"; }
die() { printf '%s  ✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

# ask "Question" default → prints the answer (default when --yes).
ask() {
  local question="$1" default="${2:-}" reply
  if [[ $ASSUME_YES -eq 1 ]]; then
    printf '%s' "$default"
    return
  fi
  read -r -p "  $question " reply </dev/tty
  printf '%s' "${reply:-$default}"
}

confirm() {
  local reply
  reply="$(ask "$1 [y/N]" "n")"
  [[ "$reply" =~ ^[Yy] ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

# Runs a command as root (sudo when needed). Only used for system packages and firewall rules.
as_root() {
  if [[ $EUID -eq 0 ]]; then "$@"
  elif have sudo; then sudo "$@"
  else die "Need root for: $* (install sudo or run as root)"
  fi
}

detect_platform() {
  if [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == *com.termux* ]]; then echo termux
  elif [[ "$(uname -s)" == Darwin ]]; then echo macos
  elif have apt-get; then echo apt
  elif have dnf; then echo dnf
  elif have yum; then echo yum
  elif have pacman; then echo pacman
  elif have zypper; then echo zypper
  elif have apk; then echo apk
  else echo unknown
  fi
}

node_ok() {
  have node || return 1
  local v major minor
  v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${v%%.*}"
  minor="$(cut -d. -f2 <<<"$v")"
  ((major > NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR)))
}

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # nvm.sh reads unset variables, so relax -u while it loads.
  set +u
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
  set -u
}

install_curl() {
  have curl && return
  case "$PLATFORM" in
    apt) as_root apt-get update -y && as_root apt-get install -y curl ca-certificates ;;
    dnf) as_root dnf install -y curl ;;
    yum) as_root yum install -y curl ;;
    pacman) as_root pacman -Sy --noconfirm curl ;;
    zypper) as_root zypper --non-interactive install curl ;;
    apk) as_root apk add --no-cache curl ;;
    *) die "Please install curl first." ;;
  esac
}

install_node() {
  case "$PLATFORM" in
    termux)
      pkg install -y nodejs-lts || pkg install -y nodejs
      ;;
    macos)
      if have brew; then
        brew install "node@$NODE_INSTALL_MAJOR"
        brew link --overwrite --force "node@$NODE_INSTALL_MAJOR"
      else
        install_node_nvm
      fi
      ;;
    apk)
      # nvm's prebuilt binaries need glibc; Alpine's own package is musl-native.
      as_root apk add --no-cache nodejs npm
      ;;
    *)
      install_node_nvm
      ;;
  esac
}

# nvm installs Node per user under ~/.nvm: no root needed and the same on every distro.
install_node_nvm() {
  install_curl
  load_nvm
  if ! have nvm; then
    echo "  Installing nvm $NVM_VERSION…"
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
    load_nvm
    have nvm || die "nvm did not install correctly."
    add_nvm_to_shell_rc
  fi
  set +u
  nvm install "$NODE_INSTALL_MAJOR"
  nvm alias default "$NODE_INSTALL_MAJOR"
  nvm use default >/dev/null
  set -u
}

add_nvm_to_shell_rc() {
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [[ -f "$rc" ]] || continue
    grep -q 'NVM_DIR' "$rc" && continue
    {
      echo ''
      echo '# nvm (added by ludo setup.sh)'
      echo 'export NVM_DIR="$HOME/.nvm"'
      echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
    } >>"$rc"
  done
}

random_secret() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("base64url"))'
}

# Reads/writes config.json through Node so the JSON stays valid.
config_get() {
  node -e 'const c=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],c); process.stdout.write(v===undefined?"":String(v))' "$APP_DIR/config.json" "$1"
}

config_set_passwords() {
  node -e '
    const fs = require("node:fs");
    const [file, create, admin] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    c.lobbyCreatePassword = create;
    c.adminPassword = admin;
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  ' "$APP_DIR/config.json" "$1" "$2"
  chmod 600 "$APP_DIR/config.json"
}

lan_ips() {
  node -e 'const os=require("node:os"); console.log(Object.values(os.networkInterfaces()).flat().filter(a=>a&&a.family==="IPv4"&&!a.internal).map(a=>a.address).join(" "))'
}

# ---------------------------------------------------------------------------

printf '%sLudo server setup%s  (%s)\n' "$BOLD" "$RESET" "$APP_DIR"
PLATFORM="$(detect_platform)"
echo "  Platform: $PLATFORM"

step "Node.js"
load_nvm
if node_ok; then
  ok "Node $(node -v) is installed"
else
  if have node; then warn "Node $(node -v) is too old (need >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR)"; fi
  [[ "$PLATFORM" == unknown ]] && warn "Unknown OS, trying nvm"
  install_node
  hash -r
  node_ok || die "Node.js >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR is still not available. Install it manually from https://nodejs.org"
  ok "Node $(node -v) is ready"
fi
have npm || die "npm is missing (it normally ships with Node.js)."
node -e 'require("node:sqlite")' 2>/dev/null || die "This Node build has no node:sqlite module. Use Node >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR."

step "Dependencies"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
ok "npm packages installed"

step "Configuration"
if [[ ! -f config.json ]]; then
  cp config.example.json config.json
  ok "Created config.json from config.example.json"
fi
create_pw="$(config_get lobbyCreatePassword)"
admin_pw="$(config_get adminPassword)"
if [[ -z "$create_pw" || "$create_pw" == change-me* || -z "$admin_pw" || "$admin_pw" == change-me* ]]; then
  gen_create="$(random_secret)"
  gen_admin="$(random_secret)"
  echo "  Set the two passwords (press Enter to use the generated one):"
  create_pw="$(ask "Lobby creation password [$gen_create]:" "$gen_create")"
  admin_pw="$(ask "Admin password [$gen_admin]:" "$gen_admin")"
  config_set_passwords "$create_pw" "$admin_pw"
  ok "Passwords saved to config.json (readable only by you)"
  SHOW_PASSWORDS=1
else
  ok "config.json already has custom passwords"
  SHOW_PASSWORDS=0
fi
mkdir -p data
HTTPS_ENABLED="$(config_get https.enabled)"
if [[ "$HTTPS_ENABLED" == "false" ]]; then
  PORT="$(config_get port)"
  REDIRECT_PORT=""
else
  PORT="$(config_get https.port)"
  REDIRECT_PORT="$(config_get https.httpRedirectPort)"
fi
# The built-in voice server's UDP ports (voice.sfu in config.json).
VOICE_PORTS=""
if [[ "$(config_get voice.sfu.enabled)" != "false" ]]; then
  VOICE_MIN="$(config_get voice.sfu.portMin)"
  VOICE_MAX="$(config_get voice.sfu.portMax)"
  VOICE_PORTS="${VOICE_MIN:-40000}:${VOICE_MAX:-40099}"
fi

if [[ $SKIP_BUILD -eq 0 ]]; then
  step "Build"
  npm run build
  ok "Built into dist/"
fi

if [[ $RUN_TESTS -eq 1 ]]; then
  step "Tests"
  npm test
  ok "All tests passed"
fi

step "Firewall"
open_ports() {
  local ports=("$PORT") p
  [[ -n "$REDIRECT_PORT" ]] && ports+=("$REDIRECT_PORT")
  # Detect without root; sudo is only used if a rule is actually added.
  if have ufw && grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then
    if confirm "ufw is active. Allow ports ${ports[*]}/tcp${VOICE_PORTS:+ and voice ${VOICE_PORTS}/udp} from the network?"; then
      for p in "${ports[@]}"; do as_root ufw allow "$p/tcp"; done
      [[ -n "$VOICE_PORTS" ]] && as_root ufw allow "$VOICE_PORTS/udp"
      ok "ufw rules added"
    else
      warn "Phones can't connect until ports ${ports[*]}/tcp are open"
    fi
  elif have firewall-cmd && systemctl is-active --quiet firewalld 2>/dev/null; then
    if confirm "firewalld is running. Allow ports ${ports[*]}/tcp${VOICE_PORTS:+ and voice ${VOICE_PORTS}/udp}?"; then
      for p in "${ports[@]}"; do as_root firewall-cmd --permanent --add-port="$p/tcp"; done
      [[ -n "$VOICE_PORTS" ]] && as_root firewall-cmd --permanent --add-port="${VOICE_PORTS/:/-}/udp"
      as_root firewall-cmd --reload
      ok "firewalld rules added"
    else
      warn "Phones can't connect until ports ${ports[*]}/tcp are open"
    fi
  else
    ok "No active ufw/firewalld found (make sure ports ${ports[*]}/tcp are reachable)"
  fi
  if [[ -n "$VOICE_PORTS" ]]; then
    warn "To play over the internet, also forward UDP ${VOICE_PORTS/:/–} on your router to this machine (voice)"
  fi
}
if [[ "$PLATFORM" == termux || "$PLATFORM" == macos ]]; then
  ok "Skipped (not needed on $PLATFORM)"
else
  open_ports
fi

if [[ $INSTALL_SERVICE -eq 1 ]]; then
  step "Service"
  if ! have systemctl || [[ "$PLATFORM" == termux || "$PLATFORM" == macos ]]; then
    warn "systemd isn't available here; start the server with: npm start"
  else
    unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    cat >"$unit_dir/ludo.service" <<EOF
[Unit]
Description=Ludo game server
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/dist/server/index.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now ludo.service
    # Keep the user's services running after logout and start them at boot.
    loginctl enable-linger "$USER" 2>/dev/null || as_root loginctl enable-linger "$USER" ||
      warn "Could not enable lingering; the server stops when you log out"
    ok "Installed and started ludo.service"
    echo "  Logs and access code:  journalctl --user -u ludo -f"
    echo "  Restart:               systemctl --user restart ludo"
  fi
fi

step "Done"
ips="$(lan_ips)"
scheme=https
[[ "$HTTPS_ENABLED" == "false" ]] && scheme=http
echo "  Start the server:   npm start"
echo "  Then open on phones:"
for ip in localhost $ips; do echo "    $scheme://$ip:$PORT"; done
echo "  The 6-digit access code is printed when the server starts (and shown in the admin panel)."
if [[ $SHOW_PASSWORDS -eq 1 ]]; then
  echo ""
  echo "  ${BOLD}Lobby creation password:${RESET} $create_pw"
  echo "  ${BOLD}Admin password:${RESET}          $admin_pw"
  echo "  (stored in config.json; change them there any time)"
fi
if [[ "$scheme" == https ]]; then
  echo ""
  echo "  Phones show a certificate warning once (self-signed). For no warning: npm run cert:mkcert"
fi
if [[ "$PLATFORM" == termux ]]; then
  echo ""
  echo "  Termux: run 'termux-wake-lock' first so Android doesn't pause the server."
fi
