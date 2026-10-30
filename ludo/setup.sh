#!/usr/bin/env bash
# Prepares a fresh machine to host the Ludo server:
#   Node.js (>= 22.13, installs 24 LTS if missing) → npm dependencies → config.json with
#   real passwords → production build → optional firewall rule, tests and systemd service.
#
# Works on Debian/Ubuntu/Raspberry Pi OS, Fedora/RHEL, Arch, openSUSE, Alpine, macOS and
# Android (Termux). Safe to run again: every step checks before it changes anything.
#
# --devinstall is the other mode: it only installs what is missing for developing, debugging
# and testing the app (Node.js, npm packages with the dev tools, the system packages and the
# Chrome the browser tests drive). It sets up no config, build, firewall or service.
#
# Usage: ./setup.sh [--yes] [--service] [--test] [--skip-build] [--devinstall] [--help]

set -euo pipefail

NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13 # first release with node:sqlite unflagged
NODE_INSTALL_MAJOR=24
NVM_VERSION=v0.40.3

ASSUME_YES=0
INSTALL_SERVICE=0
RUN_TESTS=0
SKIP_BUILD=0
DEV_INSTALL=0

usage() {
  cat <<'EOF'
Usage: ./setup.sh [options]

  --yes, -y      Don't ask questions: generate random passwords, skip the firewall prompt.
  --service      Install a systemd user service so the server starts on boot (Linux).
  --test         Run the test suite after building (with --devinstall: after installing).
  --skip-build   Install and configure only; don't build.
  --devinstall   Developer machine: install only what is missing to develop, debug and test
                 everything (Node.js, all npm packages including dev tools, system packages,
                 headless Chrome for the browser tests). No config, build, firewall or service.
  --help, -h     Show this help.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=1 ;;
    --service) INSTALL_SERVICE=1 ;;
    --test) RUN_TESTS=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --devinstall) DEV_INSTALL=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ $DEV_INSTALL -eq 1 && ( $INSTALL_SERVICE -eq 1 || $SKIP_BUILD -eq 1 ) ]]; then
  echo "--devinstall only installs tools; it can't be combined with --service or --skip-build." >&2
  exit 2
fi

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
# --devinstall: what a developer machine needs on top of a host machine. Everything below only
# adds what is missing, so running it again changes nothing that is already in place.
#
#   git, curl        clone/update the project; fetch nvm and Chrome
#   Chrome/Chromium  the browser tests (e2e/helpers.ts) launch it headless, with a fake microphone
#   alsa-utils       its /usr/share/sounds/alsa/*.wav recordings are the fake microphone's voice
#                    (e2e/makeVoiceWav.ts); without them the voice browser tests are skipped
#   emoji + Liberation fonts   the app is full of emoji; Chrome needs fonts to draw them (screenshots)
#   NSS tools        `npm run cert:mkcert` (HTTPS without certificate warnings) installs its CA with them
#   npm packages     vitest, happy-dom, puppeteer-core, tsx, vite, typescript, concurrently, coverage
#                    (no compiler is needed: nothing in package-lock.json builds native code)
# ---------------------------------------------------------------------------

DEV_GAPS=()
gap() { DEV_GAPS+=("$1"); warn "$1"; }

pkg_installed() {
  case "$PLATFORM" in
    apt) dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed' ;;
    dnf | yum | zypper) rpm -q "$1" >/dev/null 2>&1 ;;
    pacman) pacman -Qq "$1" >/dev/null 2>&1 ;;
    apk) apk info -e "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

pkg_install() {
  case "$PLATFORM" in
    apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
    dnf) as_root dnf install -y "$@" ;;
    yum) as_root yum install -y "$@" ;;
    pacman) as_root pacman -S --needed --noconfirm "$@" ;;
    zypper) as_root zypper --non-interactive install "$@" ;;
    apk) as_root apk add --no-cache "$@" ;;
    *) return 1 ;;
  esac
}

# Package names by distribution. "a|b" = a, or b where a doesn't exist (names differ between releases).
dev_package_list() {
  case "$PLATFORM" in
    apt) echo "git curl ca-certificates alsa-utils fonts-noto-color-emoji fonts-liberation libnss3-tools" ;;
    dnf | yum) echo "git curl ca-certificates alsa-utils google-noto-color-emoji-fonts|google-noto-emoji-color-fonts liberation-fonts nss-tools" ;;
    pacman) echo "git curl ca-certificates alsa-utils noto-fonts-emoji ttf-liberation nss" ;;
    zypper) echo "git curl ca-certificates alsa-utils noto-coloremoji-fonts liberation-fonts mozilla-nss-tools" ;;
    apk) echo "git curl ca-certificates alsa-utils font-noto-emoji font-liberation nss-tools" ;;
  esac
}

dev_system_packages() {
  step "System packages"
  case "$PLATFORM" in
    apt | dnf | yum | pacman | zypper | apk) ;;
    *)
      warn "No package manager known for '$PLATFORM': install git, curl, Chrome or Chromium, alsa-utils (sound files) and emoji fonts yourself."
      return
      ;;
  esac
  local item alt alts todo=() found
  for item in $(dev_package_list); do
    IFS='|' read -ra alts <<<"$item"
    found=0
    for alt in "${alts[@]}"; do
      if pkg_installed "$alt"; then found=1; break; fi
    done
    [[ $found -eq 0 ]] && todo+=("$item")
  done
  if [[ ${#todo[@]} -eq 0 ]]; then
    ok "All system packages are already installed"
  else
    echo "  Missing: ${todo[*]}"
    [[ "$PLATFORM" == apt ]] && { as_root apt-get update -y || warn "apt-get update failed, trying anyway"; }
    for item in "${todo[@]}"; do
      IFS='|' read -ra alts <<<"$item"
      found=0
      for alt in "${alts[@]}"; do
        if pkg_install "$alt"; then found=1; ok "Installed $alt"; break; fi
      done
      [[ $found -eq 0 ]] && gap "Could not install ${item//|/ or }; install it by hand."
    done
  fi
  # The fake microphone of the voice browser tests (alsa-utils' recordings).
  local wav
  for wav in Front_Left Rear_Right Front_Center Side_Left; do
    [[ -f "/usr/share/sounds/alsa/$wav.wav" ]] || { gap "/usr/share/sounds/alsa/$wav.wav is missing: the voice browser tests would be skipped (package alsa-utils)."; break; }
  done
}

# The same places e2e/helpers.ts looks in (CHROME_PATH first).
find_chrome() {
  local p
  for p in "${CHROME_PATH:-}" /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    if [[ -n "$p" && -x "$p" ]]; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

chrome_runs() {
  timeout 60 "$1" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --dump-dom about:blank >/dev/null 2>&1
}

install_chrome() {
  local tmp
  case "$PLATFORM" in
    apt)
      # Google Chrome's own .deb (x86_64 only) pulls in every library Chrome needs. On Ubuntu the
      # `chromium-browser` package is a snap stub that headless tests can't use, hence this first.
      if [[ "$(uname -m)" == x86_64 ]]; then
        install_curl
        tmp="$(mktemp -d)"
        chmod 755 "$tmp"
        echo "  Downloading Google Chrome…"
        if curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb &&
          chmod 644 "$tmp/chrome.deb" &&
          as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$tmp/chrome.deb"; then
          rm -rf "$tmp"
          return 0
        fi
        rm -rf "$tmp"
        warn "Google Chrome did not install; trying the distribution's Chromium"
      fi
      # Debian and Raspberry Pi OS have a real `chromium` package. Ubuntu has none (only the snap
      # stub `chromium-browser`, which would pull in snapd and still not run headless), so there
      # the answer is Google Chrome, or a Chrome of your own through CHROME_PATH.
      if apt-cache show chromium 2>/dev/null | grep -q '^Package: chromium$'; then
        pkg_install chromium
      else
        warn "This distribution has no non-snap Chromium package (Google Chrome is x86_64 only)."
        return 1
      fi
      ;;
    dnf | yum | pacman | zypper | apk) pkg_install chromium ;;
    *) return 1 ;;
  esac
}

dev_browser() {
  step "Chrome for the browser tests"
  local chrome
  if ! chrome="$(find_chrome)"; then
    case "$PLATFORM" in
      apt | dnf | yum | pacman | zypper | apk) install_chrome || true ;;
    esac
    chrome="$(find_chrome)" || {
      gap "No Chrome or Chromium found: 'npm run test:e2e' is skipped until one is installed (or CHROME_PATH points at one)."
      return
    }
  fi
  ok "Found $chrome"
  if have timeout; then
    if chrome_runs "$chrome"; then
      ok "It starts headless"
    else
      gap "$chrome does not start headless (a snap-packaged Chromium can't). Install Google Chrome or set CHROME_PATH."
    fi
  fi
}

dev_npm_modules() {
  step "npm packages (with the dev tools)"
  # --include=dev: vitest, happy-dom, puppeteer-core, tsx, vite and typescript are all dev
  # dependencies, and a NODE_ENV=production in the environment would otherwise leave them out.
  if npm ls --include=dev --silent >/dev/null 2>&1; then
    ok "All npm packages are already installed"
  else
    # `npm ci` installs exactly what package-lock.json says and never writes to it (`npm install`
    # can rewrite the lockfile, which a tracked file shouldn't suffer from a setup script).
    if [[ -f package-lock.json ]]; then
      npm ci --include=dev --no-audit --no-fund
    else
      npm install --include=dev --no-audit --no-fund
    fi
    npm ls --include=dev --silent >/dev/null 2>&1 && ok "npm packages installed" || gap "npm packages are still incomplete: see 'npm ls'."
  fi
  local tool
  for tool in tsc vite vitest tsx concurrently; do
    [[ -x "node_modules/.bin/$tool" ]] || gap "node_modules/.bin/$tool is missing."
  done
  [[ -d node_modules/puppeteer-core ]] || gap "puppeteer-core is missing."
}

dev_install() {
  case "$PLATFORM" in
    termux | macos) warn "System packages and Chrome aren't installed on $PLATFORM: install Chrome yourself (set CHROME_PATH if it isn't in the usual place). Doing the npm packages only." ;;
    *)
      dev_system_packages
      dev_browser
      ;;
  esac
  dev_npm_modules
  if [[ $RUN_TESTS -eq 1 ]]; then
    step "Tests"
    if npm test; then ok "All tests passed"; else gap "Some tests failed (see above)."; fi
  fi
  step "Done"
  if [[ ${#DEV_GAPS[@]} -gt 0 ]]; then
    printf '%s  Finished with %d thing(s) still missing:%s\n' "$YELLOW" "${#DEV_GAPS[@]}" "$RESET"
    local g
    for g in "${DEV_GAPS[@]}"; do echo "    - $g"; done
  else
    ok "Everything for developing, debugging and testing is installed"
  fi
  cat <<'EOF'

  npm run dev              server with live reload + Vite with HMR (config.json is created on first start)
  npm test                 unit and integration tests (npm run test:watch, npm run test:coverage)
  npm run test:e2e         build, then the browser tests in headless Chrome
  npm run typecheck        TypeScript check of server and client
  node --inspect --import tsx src/server/index.ts       debug the server (attach Chrome DevTools or VS Code)
  npx vitest run --inspect-brk --no-file-parallelism    debug the tests
EOF
  [[ ${#DEV_GAPS[@]} -eq 0 ]]
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

if [[ $DEV_INSTALL -eq 1 ]]; then
  # `exit` with dev_install's status: 0 when nothing is missing, 1 when some piece couldn't be installed.
  dev_install && exit 0 || exit 1
fi

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
