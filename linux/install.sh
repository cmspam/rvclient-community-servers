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
#
# Every question can be answered in advance through an environment variable (RV_GAME_ZIP,
# RV_DATA_DIR, RV_EDITION=community|private, RV_SETUP_CODE, RV_CONTACT, RV_NAME, RV_PUBLIC_IP,
# RV_MODES=solo,duos,..., RV_SWAP=solo,... (Zero Wait modes), RV_ZEROWAIT=pairs|spare (Zero Wait
# method), RV_KSM=on|off, RV_WEBUI=on|off).
# The game ports are 7777-7781 unless RV_PORT_BASE=<first port> (the modes get it and the next
# four) or RV_PORTS=<mode>=<port>,... says otherwise; the warm spares follow the mode's spare
# offset (100 by default).
# With RV_UNATTENDED=1 it never asks: unanswered questions take the suggested answer.
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
join_list() { local IFS="$1"; shift; echo "$*"; }
UNATTENDED=0; [[ "${RV_UNATTENDED:-}" =~ ^(1|yes|true|on)$ ]] && UNATTENDED=1
ask() {   # ask "question" "default" ["preset answer"] -> REPLY
    local q="$1" def="${2:-}" preset="${3:-}"
    if [ -n "$preset" ]; then REPLY="$preset"; info "$q: $REPLY"; return; fi
    if [ "$UNATTENDED" = 1 ]; then REPLY="$def"; info "$q: $REPLY"; return; fi
    if [ -n "$def" ]; then read -r -p "  $q [$def]: " REPLY </dev/tty; else read -r -p "  $q: " REPLY </dev/tty; fi
    REPLY="${REPLY:-$def}"
}
yesno() { ask "$1 (y/n)" "$2" "${3:-}"; [[ "$REPLY" =~ ^[Yy] ]]; }
onoff() { case "${1:-}" in on|yes|y|1|true) echo y ;; off|no|n|0|false) echo n ;; esac; }   # RV_KSM/RV_WEBUI -> y/n

[ "$UNATTENDED" = 1 ] || [ -t 0 ] || [ -e /dev/tty ] || die "Run this script in a terminal: bash install.sh"

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
# ntsync (Linux 6.14+): Wine's thread synchronization in the kernel instead of through wineserver.
# Loaded here, kept loaded after a reboot, and passed to the container; skipped when unavailable.
USE_NTSYNC=0
if [ -e /dev/ntsync ]; then USE_NTSYNC=1
elif [ "$IS_ROOT" = 1 ] && modprobe ntsync 2>/dev/null && [ -e /dev/ntsync ]; then USE_NTSYNC=1
fi
# AppArmor hosts (Ubuntu, Debian) put a profile on the container that refuses the mount that
# "ip netns add" makes, so the server pairs cannot create their namespaces. The container runs
# with apparmor=unconfined; SELinux hosts keep their label (SecurityLabelDisable covers it).
USE_APPARMOR=0
if [ -r /sys/module/apparmor/parameters/enabled ] && grep -qx Y /sys/module/apparmor/parameters/enabled; then USE_APPARMOR=1; fi
if [ "$USE_NTSYNC" = 1 ] && [ "$IS_ROOT" = 1 ] && ! grep -qsx ntsync /etc/modules-load.d/*.conf; then
    mkdir -p /etc/modules-load.d && echo ntsync > /etc/modules-load.d/rvserver-ntsync.conf
fi

bold "1. Your machine"
info "Container tool: $ENGINE    RAM: $((MEM_MB / 1024)).$(( (MEM_MB % 1024) * 10 / 1024 )) GB    Linux: $KVER"
if [ "$USE_NTSYNC" = 1 ]; then info "ntsync: available, the server will use it (faster thread synchronization in Wine)."
elif [ "$IS_ROOT" = 0 ]; then info "ntsync: not loaded (loading it needs root). The server works without it."
else info "ntsync: not available on this Linux kernel (needs 6.14 or newer). The server works without it."
fi
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
    ask "Where is your Rumbleverse game zip?" "$ZIP" "${RV_GAME_ZIP:-}"
    ZIP="$(readlink -f "${REPLY/#\~/$HOME}" 2>/dev/null || true)"
    if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
        [ "$UNATTENDED" = 1 ] || [ -n "${RV_GAME_ZIP:-}" ] && die "No game zip at ${RV_GAME_ZIP:-the usual places}."
        warn "No file there. Type the full path, e.g. /root/Rumbleverse-client-z.zip"; ZIP=""; continue
    fi
    SIZE_MB=$(( $(stat -c %s "$ZIP") / 1048576 ))
    if [ "$SIZE_MB" -lt 5000 ]; then
        [ "$UNATTENDED" = 1 ] || [ -n "${RV_GAME_ZIP:-}" ] && die "$ZIP is only ${SIZE_MB} MB - the game zip is about 11 GB."
        warn "That file is only ${SIZE_MB} MB - the game zip is about 11 GB."; ZIP=""; continue
    fi
    break
done
info "Using $ZIP (${SIZE_MB} MB)"
echo

# The zip is mounted with ":ro,z": on SELinux systems (Fedora, RHEL, CoreOS) a container may only
# read it with a container label; elsewhere the flag is ignored.

# ---------------------------------------------------------------- data folder
bold "3. Where to keep the server's files"
DEF_DATA="$HOME/rvserver"; [ "$IS_ROOT" = 1 ] && DEF_DATA="/srv/rvserver"
ask "Folder for the server (about 25 GB)" "$DEF_DATA" "${RV_DATA_DIR:-}"
DATA="${REPLY/#\~/$HOME}"
mkdir -p "$DATA"
DATA="$(readlink -f "$DATA")"
FREE_GB=$(( $(df -Pk "$DATA" | awk 'NR==2 {print $4}') / 1048576 ))
[ "$FREE_GB" -ge 25 ] || warn "Only ${FREE_GB} GB free there - about 25 GB is needed."
echo

ALREADY=0
[ -f "$DATA/state/rv.json" ] && grep -q '"nodeId": "node-' "$DATA/state/rv.json" 2>/dev/null && ALREADY=1

ENV_ARGS=()

# ---------------------------------------------------------------- game ports
# The kit's ds-instances.json is what the supervisor starts the modes on. An existing server's ports
# are read here so that a rerun opens the same ones. RV_PORT_BASE=<first port> gives solo,
# playground, duos, trios, squads that port and the next four, in that order; RV_PORTS=<mode>=<port>,...
# names a port per mode and wins over RV_PORT_BASE for that mode. The warm spares keep the mode's
# spare offset (100 by default, or what the existing file says).
declare -A PORT_OF=([solo]=7777 [playground]=7778 [duos]=7779 [trios]=7780 [squads]=7781)
declare -A SPARE_OF=([solo]=100 [duos]=100 [trios]=100 [squads]=100)
INSTANCES_FILE="$DATA/server/Rumbleverse/Binaries/Win64/RVSupervisor/ds-instances.json"
if [ -f "$INSTANCES_FILE" ]; then
    # One object per instance: id first, then port, then spareOf on a spare. The kit writes the file
    # with indentation; a compact file falls back to the ports above.
    declare -A FILE_PORT=() FILE_SPAREOF=()
    while read -r _id _port _spareof; do
        [[ "$_port" =~ ^0*[0-9]{1,5}$ ]] || continue
        _pn=$((10#${_port})); { [ "$_pn" -ge 1 ] && [ "$_pn" -le 65535 ]; } || continue
        FILE_PORT[$_id]=$_pn
        [ "$_spareof" != "-" ] && FILE_SPAREOF[$_id]=$_spareof
    done < <(awk '
        /^[[:space:]]*}/ {
            if (id != "" && port != "") print id, port, (spareof == "" ? "-" : spareof);
            id=""; port=""; spareof=""; next
        }
        /"id"[[:space:]]*:/ { id=$0; sub(/^.*"id"[[:space:]]*:[[:space:]]*"/,"",id); sub(/".*$/,"",id) }
        /"port"[[:space:]]*:/ && port == "" { port=$0; sub(/^.*"port"[[:space:]]*:[[:space:]]*/,"",port); sub(/[^0-9].*$/,"",port) }
        /"spareOf"[[:space:]]*:/ { spareof=$0; sub(/^.*"spareOf"[[:space:]]*:[[:space:]]*"/,"",spareof); sub(/".*$/,"",spareof) }
    ' "$INSTANCES_FILE")
    for _i in 0 1 2 3 4; do
        _m=${MODES_ALL[$_i]}; _main="${_m}-01"
        if [ -n "${FILE_PORT[$_main]:-}" ]; then PORT_OF[$_m]=${FILE_PORT[$_main]}; fi
    done
    _off="$(sed -n 's/.*"warmSparePortOffset"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$INSTANCES_FILE" | head -n 1)"
    if [[ "$_off" =~ ^0*[0-9]{1,5}$ ]] && [ $((10#${_off})) -gt 0 ]; then
        for _m in solo duos trios squads; do SPARE_OF[$_m]=$((10#${_off})); done
    fi
    # An explicit spare entry keeps the distance it has from its mode's port.
    for _sid in "${!FILE_PORT[@]}"; do
        _of="${FILE_SPAREOF[$_sid]:-}"
        _m=""
        case "$_of" in
            solo-01) _m=solo ;; duos-01) _m=duos ;; trios-01) _m=trios ;; squads-01) _m=squads ;;
            *) case "$_sid" in
                   solo-01-spare) _m=solo ;; duos-01-spare) _m=duos ;;
                   trios-01-spare) _m=trios ;; squads-01-spare) _m=squads ;;
               esac ;;
        esac
        if [ -n "$_m" ] && [ -n "${FILE_PORT[${_m}-01]:-}" ]; then
            _sp=${FILE_PORT[$_sid]}; _mp=${FILE_PORT[${_m}-01]}
            SPARE_OF[$_m]=$(( _sp - _mp ))
        fi
    done
fi
if [ -n "${RV_PORT_BASE:-}" ] || [ -n "${RV_PORTS:-}" ]; then
    if [ -n "${RV_PORT_BASE:-}" ]; then
        [[ "$RV_PORT_BASE" =~ ^0*[0-9]{1,5}$ ]] || die "RV_PORT_BASE must be a number from 1 to 65535."
        _base=$((10#$RV_PORT_BASE))
        { [ "$_base" -ge 1 ] && [ $((_base + 4)) -le 65535 ]; } || die "RV_PORT_BASE must leave room for 5 modes below 65535."
        for _i in 0 1 2 3 4; do PORT_OF[${MODES_ALL[$_i]}]=$((_base + _i)); done
    fi
    if [ -n "${RV_PORTS:-}" ]; then
        declare -A GIVEN=()
        _count=0
        while IFS= read -r _item; do
            _item="${_item//[[:space:]]/}"
            [ -n "$_item" ] || continue
            [[ "$_item" == *=* ]] || die "RV_PORTS: use <mode>=<port> (for example solo=7777)."
            _key="${_item%%=*}"; _val="${_item#*=}"; _key="${_key,,}"
            _mode=""
            for _m in "${MODES_ALL[@]}"; do
                [ "$_m" = "$_key" ] && _mode="$_m"
                [ "${_m}-01" = "$_key" ] && _mode="$_m"
            done
            [ -n "$_mode" ] || die "RV_PORTS: unknown mode \"$_key\" (use solo, playground, duos, trios, squads)."
            [ -z "${GIVEN[$_mode]:-}" ] || die "RV_PORTS: $_mode is given more than once."
            [[ "$_val" =~ ^0*[0-9]{1,5}$ ]] || die "RV_PORTS: $_mode=$_val is not a port number."
            _num=$((10#${_val}))
            { [ "$_num" -ge 1 ] && [ "$_num" -le 65535 ]; } || die "RV_PORTS: $_mode=$_val is outside 1-65535."
            for _k in "${!GIVEN[@]}"; do
                [ "${PORT_OF[$_k]}" = "$_num" ] && die "RV_PORTS: port $_num is used for both $_k and $_mode."
            done
            GIVEN[$_mode]=1; PORT_OF[$_mode]=$_num; _count=$((_count + 1))
        done <<< "${RV_PORTS//,/$'\n'}"
        [ "$_count" -gt 0 ] || die "RV_PORTS lists no <mode>=<port> entries."
    fi
    [ -n "${RV_PORT_BASE:-}" ] && ENV_ARGS+=(RV_PORT_BASE="$RV_PORT_BASE")
    [ -n "${RV_PORTS:-}" ] && ENV_ARGS+=(RV_PORTS="$RV_PORTS")
fi
# The supervisor refuses duplicate ports and so does the container: catch them before installing.
_seen=""
for _m in "${MODES_ALL[@]}"; do
    _p=${PORT_OF[$_m]}
    case " $_seen " in *" $_p "*) die "The game ports have a duplicate: UDP $_p." ;; esac
    _seen="$_seen $_p"
done
for _m in solo duos trios squads; do
    _p=$(( ${PORT_OF[$_m]} + ${SPARE_OF[$_m]} ))
    { [ "$_p" -ge 1 ] && [ "$_p" -le 65535 ]; } || die "The warm spare port for $_m would be $_p, outside 1-65535."
    case " $_seen " in *" $_p "*) die "The warm spare port for $_m (UDP $_p) is also a game port." ;; esac
    _seen="$_seen $_p"
done

# ---------------------------------------------------------------- server kind
if [ "$ALREADY" = 1 ]; then
    bold "5. Server already set up"
    info "This folder already holds a set-up server; its settings are kept."
    echo
else
    bold "5. What kind of server?"
    info "  1) Community server: public. Players everywhere join it through matchmaking."
    info "     Needs a VPS or dedicated server, and the rVclient admins approve it first."
    info "  2) Private server: only you and the friends you share it with."
    case "${RV_EDITION:-}" in community) PRE=1 ;; private) PRE=2 ;; *) PRE="" ;; esac
    ask "Choose 1 or 2" "1" "$PRE"
    if [ "$REPLY" = 2 ]; then
        EDITION=private
        echo
        info "Get a setup code in your rVclient launcher:"
        info "Server Status > My private servers > Set up a private server (valid 30 minutes)."
        while :; do ask "Setup code (like ABCDE-FGH23)" "" "${RV_SETUP_CODE:-}"; [ -n "$REPLY" ] && break; [ "$UNATTENDED" = 1 ] && die "A private server needs RV_SETUP_CODE."; done
        ENV_ARGS+=(RV_SETUP_CODE="$REPLY")
        ask "Name for your server (you and your friends see it)" "Linux private server" "${RV_NAME:-}"
        ENV_ARGS+=(RV_NAME="$REPLY")
    else
        EDITION=community
        echo
        info "The admins contact you on Discord about the approval."
        while :; do ask "Your Discord name" "" "${RV_CONTACT:-}"; [ -n "$REPLY" ] && break; [ "$UNATTENDED" = 1 ] && die "A community server needs RV_CONTACT (your Discord name)."; done
        ENV_ARGS+=(RV_CONTACT="$REPLY")
        ask "Name for your server (only the admins see it)" "" "${RV_NAME:-}"
        [ -n "$REPLY" ] && ENV_ARGS+=(RV_NAME="$REPLY")
    fi
    ENV_ARGS+=(RV_EDITION="$EDITION")
    echo

    # ------------------------------------------------------------ public IP
    bold "6. Public IP address"
    IP="$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
    if [ -n "$IP" ]; then info "Detected: $IP (this is the address players connect to)"; fi
    ask "Public IPv4 address" "$IP" "${RV_PUBLIC_IP:-}"
    [[ "$REPLY" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "That is not an IPv4 address."
    ENV_ARGS+=(RV_PUBLIC_IP="$REPLY")
    PUBLIC_IP="$REPLY"
    echo

    # ------------------------------------------------------------ modes
    bold "7. Which game modes?"
    # Per mode about 2.9 GB while it loads, 2.5 GB after (the server kit's Server.dll frees the
    # data a server never uses); with memory sharing (KSM) each further mode needs about 1.8 GB either way.
    USABLE=$(( MEM_MB - 900 ))
    FIRST=2900; EACH=2500
    FIT_PLAIN=$(( 1 + (USABLE - FIRST) / EACH )); [ "$USABLE" -lt "$FIRST" ] && FIT_PLAIN=1
    FIT_KSM=$FIT_PLAIN
    if [ "$KSM_KERNEL" = 1 ] && [ "$IS_ROOT" = 1 ] && [ "$USABLE" -ge "$FIRST" ]; then
        FIT_KSM=$(( 1 + (USABLE - FIRST) / 1800 )); [ "$FIT_KSM" -lt "$FIT_PLAIN" ] && FIT_KSM=$FIT_PLAIN
    fi
    [ "$FIT_KSM" -gt 5 ] && FIT_KSM=5; [ "$FIT_PLAIN" -gt 5 ] && FIT_PLAIN=5
    info "Each mode is its own game server. With $((MEM_MB / 1024)).$(( (MEM_MB % 1024) * 10 / 1024 )) GB of RAM about $FIT_PLAIN fit"
    [ "$FIT_KSM" -gt "$FIT_PLAIN" ] && info "(about $FIT_KSM with memory sharing, which this installer can switch on)."
    for i in 0 1 2 3 4; do info "  $((i + 1))) ${MODE_LABEL[$i]}"; done
    if [ "$EDITION" = private ]; then DEF_MODES="2"; else DEF_MODES="1"; [ "$FIT_KSM" -ge 2 ] && DEF_MODES="1 2"; fi
    [ "$FIT_KSM" -ge 5 ] && DEF_MODES="1 2 3 4 5"
    PRE=""
    if [ -n "${RV_MODES:-}" ]; then
        for m in ${RV_MODES//,/ }; do
            for i in 0 1 2 3 4; do [ "${MODES_ALL[$i]}" = "$m" ] && PRE="${PRE:+$PRE }$((i + 1))"; done
        done
        [ -n "$PRE" ] || die "RV_MODES lists no known mode (use solo, playground, duos, trios, squads)."
    fi
    ask "Modes to run (numbers separated by spaces)" "$DEF_MODES" "$PRE"
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

# ---------------------------------------------------------------- Zero Wait
# Two methods. Server pairs (the default for now): one port, the container forwards it between two
# servers and switches after the round's match reports are uploaded. Warm spare: the kit's second
# server on the mode's spare port (by default the mode's port + 100), both registered, the backend
# sends players to the idle one.
# Server pairs need IP forwarding and the network rights given here when installed as root.
bold "8. Zero Wait (no waiting between matches)"
case "${RV_ZEROWAIT:-}" in
    ""|pairs|spare) ;;
    *) die "RV_ZEROWAIT must be pairs or spare." ;;
esac
info "Two ways to keep the next match ready:"
info "  1) Server pairs (default): two servers, the mode's own port. The container switches the"
info "     port after the round's match reports are uploaded."
info "  2) Warm spare: a second server on the mode's spare port (by default the mode's port + 100)."
info "     Both report to the backend, which sends players to the one in its lobby."
case "${RV_ZEROWAIT:-}" in pairs) PRE_METHOD=1 ;; spare) PRE_METHOD=2 ;; *) PRE_METHOD="" ;; esac
ask "Choose 1 or 2" "1" "$PRE_METHOD"
case "$REPLY" in
    1|pairs) METHOD=pairs ;;
    2|spare) METHOD=spare ;;
    *) die "Choose 1 (server pairs) or 2 (warm spare)." ;;
esac
[ "$METHOD" = spare ] && ENV_ARGS+=(RV_ZEROWAIT=spare)
[ "$IS_ROOT" = 0 ] && [ "$METHOD" = pairs ] && warn "Without root the container gets no NET_ADMIN/SYS_ADMIN: Zero Wait falls back to the warm spare."
if [ "$IS_ROOT" = 1 ]; then
    printf '# Rumbleverse server (Zero Wait server pairs): the container forwards between its game servers and the internet.\nnet.ipv4.ip_forward = 1\n' > /etc/sysctl.d/80-rvserver-forward.conf
    sysctl -q -w net.ipv4.ip_forward=1
fi
SWAP=""
if true; then
    if [ -z "${MODES:-}" ]; then info "No modes chosen yet: switch Zero Wait on later on the web page (Zero Wait switch) or with rv swap on <mode>."
    else
        info "Normally a mode needs a minute or two between matches while its server restarts. With Zero Wait"
        info "a second server of that mode is already started and waiting, so players queue straight into the"
        info "next match. It needs memory for one more server of that mode (about $((EACH / 1000)).$(( (EACH % 1000) / 100 )) GB)."
        if [ "$METHOD" = spare ]; then
            _hint=""
            for _i in 0 1 2 3 4; do
                _m=${MODES_ALL[$_i]}
                case "$_m" in solo|duos|trios|squads)
                    _hint="${_hint:+$_hint, }${MODE_LABEL[$_i]} $(( ${PORT_OF[$_m]} + ${SPARE_OF[$_m]} ))" ;;
                esac
            done
            info "With the warm spare method that server's port must also be open: ${_hint}."
        fi
        # Suggest the battle royale modes (in the order chosen) that still fit next to the modes chosen.
        LEFT=$(( USABLE - FIRST - (COUNT - 1) * EACH )); DEF_SWAP=""
        for m in solo duos trios squads; do
            [[ ",$MODES," == *",$m,"* ]] || continue
            [ "$LEFT" -ge "$EACH" ] || break
            DEF_SWAP="${DEF_SWAP:+$DEF_SWAP,}$m"; LEFT=$(( LEFT - EACH ))
        done
        info "Your modes: ${MODES//,/, }. ${DEF_SWAP:+Memory for Zero Wait in: ${DEF_SWAP//,/, }. }Leave empty for none."
        ask "Modes with Zero Wait (names separated by commas, or all)" "$DEF_SWAP" "${RV_SWAP:-}"
        for m in ${REPLY//,/ }; do
            if [ "$m" = all ]; then SWAP="$MODES"; break; fi
            [[ ",$MODES," == *",$m,"* ]] || die "\"$m\" is not one of your modes ($MODES)."
            SWAP="${SWAP:+$SWAP,}$m"
        done
        if [ -n "$SWAP" ]; then
            NEED=$(( FIRST + (COUNT - 1 + $(echo "$SWAP" | tr ',' '\n' | sort -u | wc -l)) * EACH ))
            [ "$NEED" -gt "$USABLE" ] && warn "That is about $((NEED / 1024)) GB for all servers; this machine has $((MEM_MB / 1024)) GB."
            ENV_ARGS+=(RV_SWAP="$SWAP")
            info "Zero Wait: ${SWAP//,/, }. It can be switched per mode at any time on the web page."
        else info "No Zero Wait for now. It can be switched on per mode at any time on the web page."; fi
    fi
fi
echo

# ---------------------------------------------------------------- memory sharing (KSM)
bold "9. Memory sharing (KSM)"
USE_KSM=0
if [ "$KSM_KERNEL" = 0 ]; then info "Not available on this Linux kernel (needs 6.4 or newer). Skipped."
elif [ "$IS_ROOT" = 0 ]; then info "Needs root. Skipped (run the installer with sudo to use it)."
else
    info "Several modes share part of their memory. With this on, each extra mode needs about"
    info "1.8 GB. It costs some CPU, so it is only worth it with more than one mode."
    DEF_KSM=y; [ "${COUNT:-2}" -le 1 ] && DEF_KSM=n
    if yesno "Switch memory sharing on?" "$DEF_KSM" "$(onoff "${RV_KSM:-}")"; then
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
bold "10. Web admin page"
info "A password-protected page to manage the server from your browser (port $WEB_PORT)."
info "Everything can also be done in the terminal with: $ENGINE exec -it $NAME rv menu"
USE_WEB=1; yesno "Turn on the web admin page?" "y" "$(onoff "${RV_WEBUI:-}")" || USE_WEB=0
echo

# ---------------------------------------------------------------- firewall
# The ports this box uses: the modes chosen on a new server, every mode on an existing one (its
# choice lives in its own files), and the warm spares only with the warm spare method.
FW_MODES=()
if [ -n "${MODES:-}" ]; then IFS=, read -r -a FW_MODES <<< "$MODES"; else FW_MODES=("${MODES_ALL[@]}"); fi
MAIN_PORTS=()
for _m in "${FW_MODES[@]}"; do [ -n "${PORT_OF[$_m]:-}" ] && MAIN_PORTS+=("${PORT_OF[$_m]}"); done
if [ ${#MAIN_PORTS[@]} -gt 0 ]; then
    mapfile -t MAIN_PORTS < <(printf '%s\n' "${MAIN_PORTS[@]}" | sort -n -u)
fi
MAIN_TEXT="$(join_list ', ' "${MAIN_PORTS[@]}")"
SPARE_PORTS=()
if [ "$METHOD" = spare ]; then
    if [ -n "${SWAP:-}" ]; then IFS=, read -r -a _swap <<< "$SWAP"; else _swap=(solo duos trios squads); fi
    for _m in "${_swap[@]}"; do
        case "$_m" in solo|duos|trios|squads) SPARE_PORTS+=($(( ${PORT_OF[$_m]} + ${SPARE_OF[$_m]} ))) ;; esac
    done
    if [ ${#SPARE_PORTS[@]} -gt 0 ]; then
        mapfile -t SPARE_PORTS < <(printf '%s\n' "${SPARE_PORTS[@]}" | sort -n -u)
    fi
fi
SPARE_TEXT=""
if [ ${#SPARE_PORTS[@]} -gt 0 ]; then SPARE_TEXT="$(join_list ', ' "${SPARE_PORTS[@]}")"; fi
OPEN_PORTS=""
[ "$USE_WEB" = 1 ] && OPEN_PORTS="$WEB_PORT/tcp"
if [ "$IS_ROOT" = 1 ]; then
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        for _p in "${MAIN_PORTS[@]}"; do firewall-cmd -q --permanent --add-port="$_p/udp"; done
        if [ ${#SPARE_PORTS[@]} -gt 0 ]; then
            for _p in "${SPARE_PORTS[@]}"; do firewall-cmd -q --permanent --add-port="$_p/udp"; done
        fi
        [ "$USE_WEB" = 1 ] && firewall-cmd -q --permanent --add-port="$WEB_PORT/tcp"
        firewall-cmd -q --reload
        info "Firewall (firewalld): opened UDP ${MAIN_TEXT}${SPARE_TEXT:+, and ${SPARE_TEXT} for Zero Wait}${OPEN_PORTS:+ and $OPEN_PORTS}."
    elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
        for _p in "${MAIN_PORTS[@]}"; do ufw allow "$_p/udp" >/dev/null; done
        if [ ${#SPARE_PORTS[@]} -gt 0 ]; then
            for _p in "${SPARE_PORTS[@]}"; do ufw allow "$_p/udp" >/dev/null; done
        fi
        [ "$USE_WEB" = 1 ] && ufw allow "$WEB_PORT/tcp" >/dev/null
        info "Firewall (ufw): opened UDP ${MAIN_TEXT}${SPARE_TEXT:+, and ${SPARE_TEXT} for Zero Wait}${OPEN_PORTS:+ and $OPEN_PORTS}."
    fi
fi

# ---------------------------------------------------------------- start
bold "11. Starting the server"
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
        echo "Pull=newer"   # a newer image is taken at a start; the container restarts for it when its servers are empty
        # SYS_RESOURCE: KSM, and starting game servers at low CPU priority; NET_ADMIN SYS_ADMIN: the server pairs
        # of server kits before 2026.10.10.1 (network namespaces and nftables)
        CAPS="SYS_RESOURCE"; [ "$IS_ROOT" = 1 ] && CAPS="SYS_RESOURCE NET_ADMIN SYS_ADMIN"
        [ -n "$CAPS" ] && echo "AddCapability=$CAPS"
        [ "$IS_ROOT" = 1 ] && echo "SecurityLabelDisable=true"
        [ "$IS_ROOT" = 1 ] && [ "$USE_APPARMOR" = 1 ] && echo "PodmanArgs=--security-opt=apparmor=unconfined"
        [ "$USE_NTSYNC" = 1 ] && echo "AddDevice=/dev/ntsync"
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
    else
        systemctl --user daemon-reload
        systemctl --user start "$NAME.service"
        loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "Could not enable linger: the server may stop when you log out."
    fi
    info "Installed as a systemd service ($NAME.service): starts at boot, updates itself."
else
    ARGS=(--name "$NAME" --network host -v "$ZIP:/game.zip:ro,z" -v "$DATA:/data:Z")
    if [ "$IS_ROOT" = 1 ]; then
        ARGS+=(--cap-add SYS_RESOURCE --cap-add NET_ADMIN --cap-add SYS_ADMIN --security-opt label=disable)
        if [ "$ENGINE" = docker ] || [ "$USE_APPARMOR" = 1 ]; then ARGS+=(--security-opt apparmor=unconfined); fi
    else ARGS+=(--cap-add SYS_RESOURCE); fi
    [ "$USE_NTSYNC" = 1 ] && ARGS+=(--device /dev/ntsync)
    for e in "${ENV_ARGS[@]}"; do ARGS+=(-e "$e"); done
    if [ "$ENGINE" = docker ] && [ "$IS_ROOT" = 1 ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        # A systemd service that pulls a newer image at every start (docker run --pull always), so the
        # container's own image updates (it restarts for a newer image once its servers are empty) work.
        DOCKER_BIN="$(command -v docker)"; UNIT="/etc/systemd/system/$NAME.service"
        {
            echo "# Rumbleverse server - written by install.sh"
            echo "[Unit]"
            echo "Description=Rumbleverse server"
            echo "Wants=network-online.target docker.service"
            echo "After=network-online.target docker.service"
            echo
            echo "[Service]"
            echo "ExecStartPre=-$DOCKER_BIN rm -f $NAME"
            # systemd quoting: each argument in double quotes; \ and " escaped, % and $ doubled
            sdq() { local a="$1"; a="${a//\\/\\\\}"; a="${a//\"/\\\"}"; a="${a//%/%%}"; a="${a//\$/\$\$}"; printf ' "%s"' "$a"; }
            printf 'ExecStart=%s run --rm --pull always' "$DOCKER_BIN"; for x in "${ARGS[@]}" "$IMAGE"; do sdq "$x"; done; echo
            echo "ExecStop=$DOCKER_BIN stop -t 80 $NAME"
            echo "Restart=always"
            echo "TimeoutStartSec=900"
            echo "TimeoutStopSec=90"
            echo
            echo "[Install]"
            echo "WantedBy=multi-user.target"
        } > "$UNIT"
        chmod 600 "$UNIT"
        systemctl daemon-reload
        systemctl enable --now "$NAME.service" >/dev/null 2>&1
        QUADLET="$UNIT"
        info "Installed as a systemd service ($NAME.service): starts at boot, updates itself."
    else
        $ENGINE run -d --restart=unless-stopped "${ARGS[@]}" "$IMAGE" >/dev/null
        info "Started (restarts by itself; make sure $ENGINE starts at boot)."
        info "Image updates: run the installer again from time to time (or pull the image and re-create the container)."
    fi
fi

# ---------------------------------------------------------------- result
# An existing setup keeps its state; the method chosen above wins over the environment.
if [ "$ALREADY" = 1 ]; then
    $ENGINE exec "$NAME" rv swap method "$METHOD" >/dev/null 2>&1 \
        && info "Zero Wait method: $METHOD (applies when the servers are empty)." \
        || info "Set the Zero Wait method later: $ENGINE exec $NAME rv swap method $METHOD"
fi
PASS=""
if [ "$USE_WEB" = 1 ]; then
    # The password is printed once, in the first start's banner. Read the log as it is written and
    # stop at that line instead of asking the engine for the whole log every second; give up after
    # 60 s. The password is the first non-empty line after the heading.
    while IFS= read -r -t 60 _line <&3; do
        if [[ "$_line" == *"admin password"* ]]; then
            while IFS= read -r -t 5 _pw <&3; do
                _pw="${_pw// /}"
                if [ -n "$_pw" ]; then PASS="$_pw"; break 2; fi
            done
        fi
    done 3< <(timeout 60 "$ENGINE" logs -f "$NAME" 2>&1)
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
info "Game ports:       UDP ${MAIN_TEXT}${SPARE_TEXT:+, and ${SPARE_TEXT} for Zero Wait (warm spare)} (also open them in your provider's firewall, if it has one)"
echo
if [ "${EDITION:-}" = community ]; then
    info "Your community server waits for approval by the rVclient admins. Nothing else to do."
elif [ "${EDITION:-}" = private ]; then
    info "Your private server appears in your launcher: Server Status > My private servers > Join."
fi
echo
