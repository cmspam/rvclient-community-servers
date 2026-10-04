#!/usr/bin/env bash
# Rumbleverse server installer for Linux.
#
# Asks a few questions, checks the machine, and starts the server in a container
# (Podman or Docker). Run it as root (or with sudo) on a VPS:
#
#   curl -fsSLo install.sh https://raw.githubusercontent.com/cmspam/rvclient-community-servers/main/linux/install.sh
#   sudo bash install.sh
#
# Running it again later changes nothing that is already set up; it can re-create the container.
set -euo pipefail

IMAGE="${RV_IMAGE:-ghcr.io/cmspam/rvclient-community-servers:latest}"
NAME="${RV_CONTAINER:-rvserver}"
WEB_PORT="${RV_WEBUI_PORT:-8080}"
MODES_ALL=(solo playground duos trios squads)
MODE_LABEL=([0]="Solos" [1]="Playground" [2]="Duos" [3]="Trios" [4]="Squads")

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  %s\033[0m\n' "$*"; }
die() { printf '\033[31m\n  %s\033[0m\n\n' "$*" >&2; exit 1; }
ask() {   # ask "question" "default" -> REPLY
    local q="$1" def="${2:-}"
    if [ -n "$def" ]; then read -r -p "  $q [$def]: " REPLY </dev/tty; else read -r -p "  $q: " REPLY </dev/tty; fi
    REPLY="${REPLY:-$def}"
}
yesno() { ask "$1 (y/n)" "$2"; [[ "$REPLY" =~ ^[Yy] ]]; }

[ -t 0 ] || [ -e /dev/tty ] || die "Run this script in a terminal: bash install.sh"

echo
bold "Rumbleverse server installer"
echo
info "This sets up a Rumbleverse server on this machine. You need your own copy of the game"
info "(the Rumbleverse client zip). Press Enter to accept the suggestion shown in [brackets]."
echo

# ---------------------------------------------------------------- machine check
IS_ROOT=0; [ "$(id -u)" = 0 ] && IS_ROOT=1
ARCH="$(uname -m)"
[ "$ARCH" = x86_64 ] || die "This needs a 64-bit x86 (x86_64) machine; this one is $ARCH."

ENGINE=""
if command -v podman >/dev/null 2>&1; then ENGINE=podman
elif command -v docker >/dev/null 2>&1; then ENGINE=docker
fi
if [ -z "$ENGINE" ]; then
    warn "Neither Podman nor Docker is installed."
    info "Install one of them first, for example:"
    info "  Debian/Ubuntu:  sudo apt install podman"
    info "  Fedora/RHEL:    sudo dnf install podman"
    info "  Arch:           sudo pacman -S podman"
    die "Then run this installer again."
fi
if [ "$ENGINE" = docker ] && ! docker info >/dev/null 2>&1; then
    die "Docker is installed but not usable by this user. Run the installer with sudo."
fi

MEM_MB=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
KVER="$(uname -r)"; KMAJ=${KVER%%.*}; KMIN=${KVER#*.}; KMIN=${KMIN%%.*}
KSM_KERNEL=0; { [ "$KMAJ" -gt 6 ] || { [ "$KMAJ" -eq 6 ] && [ "$KMIN" -ge 4 ]; }; } && [ -e /sys/kernel/mm/ksm/run ] && KSM_KERNEL=1

bold "1. Your machine"
info "Container tool: $ENGINE    RAM: $((MEM_MB / 1024)).$(( (MEM_MB % 1024) * 10 / 1024 )) GB    Linux: $KVER"
if [ "$IS_ROOT" = 0 ]; then
    warn "Not running as root. That works, but memory sharing between modes (KSM) needs root."
    warn "Press Ctrl+C and run 'sudo bash install.sh' instead to use it."
fi
echo

# ---------------------------------------------------------------- game zip
bold "2. Your game zip"
ZIP=""
for f in "${RV_GAME_ZIP:-}" ./Rumbleverse*.zip ~/Rumbleverse*.zip ~/Downloads/Rumbleverse*.zip /root/Rumbleverse*.zip; do
    [ -n "$f" ] && [ -f "$f" ] && { ZIP="$(readlink -f "$f")"; break; }
done
while :; do
    ask "Where is your Rumbleverse game zip?" "$ZIP"
    ZIP="$(readlink -f "${REPLY/#\~/$HOME}" 2>/dev/null || true)"
    if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then warn "No file there. Type the full path, e.g. /root/Rumbleverse-client-z.zip"; ZIP=""; continue; fi
    SIZE_MB=$(( $(stat -c %s "$ZIP") / 1048576 ))
    if [ "$SIZE_MB" -lt 5000 ]; then warn "That file is only ${SIZE_MB} MB - the game zip is about 11 GB."; ZIP=""; continue; fi
    break
done
info "Using $ZIP (${SIZE_MB} MB)"
echo

# The zip is mounted with ":ro,z": on SELinux systems (Fedora, RHEL, CoreOS) a container may only
# read it with a container label; elsewhere the flag is ignored.

# ---------------------------------------------------------------- data folder
bold "3. Where to keep the server's files"
DEF_DATA="$HOME/rvserver"; [ "$IS_ROOT" = 1 ] && DEF_DATA="/srv/rvserver"
ask "Folder for the server (about 25 GB)" "$DEF_DATA"
DATA="${REPLY/#\~/$HOME}"
mkdir -p "$DATA"
DATA="$(readlink -f "$DATA")"
FREE_GB=$(( $(df -Pk "$DATA" | awk 'NR==2 {print $4}') / 1048576 ))
[ "$FREE_GB" -ge 25 ] || warn "Only ${FREE_GB} GB free there - about 25 GB is needed."
echo

ALREADY=0
[ -f "$DATA/state/rv.json" ] && grep -q '"nodeId": "node-' "$DATA/state/rv.json" 2>/dev/null && ALREADY=1

# ---------------------------------------------------------------- server kind
ENV_ARGS=()
if [ "$ALREADY" = 1 ]; then
    bold "4. Server already set up"
    info "This folder already holds a set-up server; its settings are kept."
    echo
else
    bold "4. What kind of server?"
    info "  1) Community server: public. Players everywhere join it through matchmaking."
    info "     Needs a VPS or dedicated server, and the rVclient admins approve it first."
    info "  2) Private server: only you and the friends you share it with."
    ask "Choose 1 or 2" "1"
    if [ "$REPLY" = 2 ]; then
        EDITION=private
        echo
        info "Get a setup code in your rVclient launcher:"
        info "Server Status > My private servers > Set up a private server (valid 30 minutes)."
        while :; do ask "Setup code (like ABCDE-FGH23)" ""; [ -n "$REPLY" ] && break; done
        ENV_ARGS+=(RV_SETUP_CODE="$REPLY")
        ask "Name for your server (you and your friends see it)" "Linux private server"
        ENV_ARGS+=(RV_NAME="$REPLY")
    else
        EDITION=community
        echo
        info "The admins contact you on Discord about the approval."
        while :; do ask "Your Discord name" ""; [ -n "$REPLY" ] && break; done
        ENV_ARGS+=(RV_CONTACT="$REPLY")
        ask "Name for your server (only the admins see it)" ""
        [ -n "$REPLY" ] && ENV_ARGS+=(RV_NAME="$REPLY")
    fi
    ENV_ARGS+=(RV_EDITION="$EDITION")
    echo

    # ------------------------------------------------------------ public IP
    bold "5. Public IP address"
    IP="$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
    if [ -n "$IP" ]; then info "Detected: $IP (this is the address players connect to)"; fi
    ask "Public IPv4 address" "$IP"
    [[ "$REPLY" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "That is not an IPv4 address."
    ENV_ARGS+=(RV_PUBLIC_IP="$REPLY")
    PUBLIC_IP="$REPLY"
    echo

    # ------------------------------------------------------------ modes
    bold "6. Which game modes?"
    # About 3.8 GB for the first mode; with memory sharing (KSM) about 1.7 GB for each further one.
    USABLE=$(( MEM_MB - 900 ))
    FIT_PLAIN=$(( USABLE / 3900 )); [ "$FIT_PLAIN" -lt 1 ] && FIT_PLAIN=1
    FIT_KSM=$FIT_PLAIN
    if [ "$KSM_KERNEL" = 1 ] && [ "$IS_ROOT" = 1 ]; then
        FIT_KSM=$(( 1 + (USABLE - 3900 - 1800) / 1800 )); [ "$FIT_KSM" -lt "$FIT_PLAIN" ] && FIT_KSM=$FIT_PLAIN
    fi
    [ "$FIT_KSM" -gt 5 ] && FIT_KSM=5; [ "$FIT_PLAIN" -gt 5 ] && FIT_PLAIN=5
    info "Each mode is its own game server. With $((MEM_MB / 1024)).$(( (MEM_MB % 1024) * 10 / 1024 )) GB of RAM about $FIT_PLAIN fit"
    [ "$FIT_KSM" -gt "$FIT_PLAIN" ] && info "(about $FIT_KSM with memory sharing, which this installer can switch on)."
    for i in 0 1 2 3 4; do info "  $((i + 1))) ${MODE_LABEL[$i]}"; done
    if [ "$EDITION" = private ]; then DEF_MODES="2"; else DEF_MODES="1"; [ "$FIT_KSM" -ge 2 ] && DEF_MODES="1 2"; fi
    [ "$FIT_KSM" -ge 5 ] && DEF_MODES="1 2 3 4 5"
    ask "Modes to run (numbers separated by spaces)" "$DEF_MODES"
    MODES=""
    for n in $REPLY; do
        [[ "$n" =~ ^[1-5]$ ]] || die "Use the numbers 1 to 5."
        MODES="${MODES:+$MODES,}${MODES_ALL[$((n - 1))]}"
    done
    COUNT=$(echo "$MODES" | tr ',' '\n' | sort -u | wc -l)
    [ "$COUNT" -gt "$FIT_KSM" ] && warn "$COUNT modes may be more than this machine can run smoothly. You can switch modes off later."
    ENV_ARGS+=(RV_MODES="$MODES")
    echo
fi

# ---------------------------------------------------------------- memory sharing (KSM)
bold "7. Memory sharing (KSM)"
USE_KSM=0
if [ "$KSM_KERNEL" = 0 ]; then info "Not available on this Linux kernel (needs 6.4 or newer). Skipped."
elif [ "$IS_ROOT" = 0 ]; then info "Needs root. Skipped (run the installer with sudo to use it)."
else
    info "Several modes share most of their memory. With this on, each extra mode needs about"
    info "1.7 GB instead of 3.8 GB. It costs a little CPU."
    if yesno "Switch memory sharing on?" "y"; then
        USE_KSM=1
        cat > /etc/tmpfiles.d/rvserver-ksm.conf <<'EOF'
# Kernel Samepage Merging for the Rumbleverse server (identical memory of several modes kept once).
w /sys/kernel/mm/ksm/run - - - - 1
w /sys/kernel/mm/ksm/pages_to_scan - - - - 1000
w /sys/kernel/mm/ksm/use_zero_pages - - - - 1
EOF
        if command -v systemd-tmpfiles >/dev/null 2>&1; then systemd-tmpfiles --create /etc/tmpfiles.d/rvserver-ksm.conf
        else echo 1 > /sys/kernel/mm/ksm/run; echo 1000 > /sys/kernel/mm/ksm/pages_to_scan; echo 1 > /sys/kernel/mm/ksm/use_zero_pages; fi
        info "Memory sharing is on (and stays on after a reboot)."
    fi
fi
echo

# ---------------------------------------------------------------- web admin page
bold "8. Web admin page"
info "A password-protected page to manage the server from your browser (port $WEB_PORT)."
info "Everything can also be done in the terminal with: $ENGINE exec -it $NAME rv menu"
USE_WEB=1; yesno "Turn on the web admin page?" "y" || USE_WEB=0
echo

# ---------------------------------------------------------------- firewall
OPEN_PORTS=""
[ "$USE_WEB" = 1 ] && OPEN_PORTS="$WEB_PORT/tcp"
if [ "$IS_ROOT" = 1 ]; then
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        firewall-cmd -q --permanent --add-port=7777-7781/udp
        [ "$USE_WEB" = 1 ] && firewall-cmd -q --permanent --add-port="$WEB_PORT/tcp"
        firewall-cmd -q --reload; info "Firewall (firewalld): opened UDP 7777-7781${OPEN_PORTS:+ and $OPEN_PORTS}."
    elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow 7777:7781/udp >/dev/null
        [ "$USE_WEB" = 1 ] && ufw allow "$WEB_PORT/tcp" >/dev/null
        info "Firewall (ufw): opened UDP 7777-7781${OPEN_PORTS:+ and $OPEN_PORTS}."
    fi
fi

# ---------------------------------------------------------------- start
bold "9. Starting the server"
[ "$USE_KSM" = 1 ] && ENV_ARGS+=(RV_KSM=on)
[ "$USE_WEB" = 0 ] && ENV_ARGS+=(RV_WEBUI=off)
[ "$WEB_PORT" != 8080 ] && ENV_ARGS+=(RV_WEBUI_PORT="$WEB_PORT")

info "Downloading the server image (about 800 MB)..."
if ! $ENGINE pull -q "$IMAGE" >/dev/null 2>&1; then
    $ENGINE image inspect "$IMAGE" >/dev/null 2>&1 || die "Could not download $IMAGE. Check the internet connection and try again."
    warn "Could not download a newer image; using the one already on this machine."
fi
$ENGINE rm -f "$NAME" >/dev/null 2>&1 || true

QUADLET=""
if [ "$ENGINE" = podman ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$IS_ROOT" = 1 ]; then QDIR=/etc/containers/systemd; else QDIR="$HOME/.config/containers/systemd"; fi
    mkdir -p "$QDIR"
    QUADLET="$QDIR/$NAME.container"
    {
        echo "# Rumbleverse server - written by install.sh"
        echo "[Unit]"
        echo "Description=Rumbleverse server"
        echo "Wants=network-online.target"
        echo "After=network-online.target"
        echo
        echo "[Container]"
        echo "ContainerName=$NAME"
        echo "Image=$IMAGE"
        echo "Network=host"
        echo "Volume=$ZIP:/game.zip:ro,z"
        echo "Volume=$DATA:/data:Z"
        echo "AutoUpdate=registry"
        [ "$USE_KSM" = 1 ] && echo "AddCapability=SYS_RESOURCE"
        for e in "${ENV_ARGS[@]}"; do echo "Environment=\"$e\""; done
        echo
        echo "[Service]"
        echo "Restart=always"
        echo "TimeoutStartSec=900"
        echo "TimeoutStopSec=90"
        echo
        echo "[Install]"
        if [ "$IS_ROOT" = 1 ]; then echo "WantedBy=multi-user.target"; else echo "WantedBy=default.target"; fi
    } > "$QUADLET"
    chmod 600 "$QUADLET"
    if [ "$IS_ROOT" = 1 ]; then
        systemctl daemon-reload
        systemctl start "$NAME.service"
        systemctl enable podman-auto-update.timer >/dev/null 2>&1 || true
    else
        systemctl --user daemon-reload
        systemctl --user start "$NAME.service"
        systemctl --user enable podman-auto-update.timer >/dev/null 2>&1 || true
        loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "Could not enable linger: the server may stop when you log out."
    fi
    info "Installed as a systemd service ($NAME.service): starts at boot, updates itself."
else
    RUN=($ENGINE run -d --name "$NAME" --restart=unless-stopped --network host
        -v "$ZIP:/game.zip:ro,z" -v "$DATA:/data:Z")
    [ "$USE_KSM" = 1 ] && RUN+=(--cap-add SYS_RESOURCE)
    for e in "${ENV_ARGS[@]}"; do RUN+=(-e "$e"); done
    RUN+=("$IMAGE")
    "${RUN[@]}" >/dev/null
    info "Started (restarts by itself; make sure $ENGINE starts at boot)."
fi

# ---------------------------------------------------------------- result
PASS=""
if [ "$USE_WEB" = 1 ]; then
    for _ in $(seq 60); do
        PASS="$($ENGINE logs "$NAME" 2>&1 | awk '/admin password/ {getline; getline; gsub(/ /, ""); print; exit}' || true)"
        [ -n "$PASS" ] && break
        sleep 1
    done
fi
HOSTIP="${PUBLIC_IP:-$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"

echo
bold "Done."
echo
if [ "$ALREADY" = 0 ]; then
    info "The server now unpacks the game, registers itself and downloads the server kit."
    info "That usually takes a few minutes (longer on a slow connection). It starts by itself afterwards."
    echo
fi
if [ "$USE_WEB" = 1 ]; then
    info "Web admin page:   http://$HOSTIP:$WEB_PORT"
    if [ -n "$PASS" ]; then info "Admin password:   $PASS   (you choose your own at the first login)"
    else info "Admin password:   see '$ENGINE logs $NAME' (only shown on the first start)"; fi
    warn "The page uses plain HTTP. Only open port $WEB_PORT to addresses you trust."
fi
info "Progress / log:   $ENGINE logs -f $NAME"
info "Terminal menu:    $ENGINE exec -it $NAME rv menu"
if [ -n "$QUADLET" ]; then
    if [ "$IS_ROOT" = 1 ]; then info "Service:          systemctl status $NAME"; else info "Service:          systemctl --user status $NAME"; fi
fi
info "Game ports:       UDP 7777-7781 (also open them in your provider's firewall, if it has one)"
echo
if [ "${EDITION:-}" = community ]; then
    info "Your community server waits for approval by the rVclient admins. Nothing else to do."
elif [ "${EDITION:-}" = private ]; then
    info "Your private server appears in your launcher: Server Status > My private servers > Join."
fi
echo
