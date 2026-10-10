# rVclient Community & Private Servers

Host your own Rumbleverse server with rVclient, on **Windows** or **Linux**.

| | Private server | Community server |
|---|---|---|
| Who plays on it | You + your friends | Everyone in your region |
| Where it runs | Your own PC (or a server) | A VPS or dedicated server |
| How people join | Friends see it in their launcher (Tailscale or Radmin VPN on Windows) | Public matchmaking (after the rVclient admins approve it), tagged **Community** in the launcher |

## Good to know

- You need **your own copy of Rumbleverse** (the game files). This project never provides game files.
- Players need the **rVclient launcher 1.7.49 or newer**.
- Each game mode is its own server and needs about **4 GB of RAM** (about 2.5 GB on Linux, see [Saving memory](#saving-memory)).
- Server updates arrive by themselves through the rVclient backend.

**Contents:** [Windows](#windows) · [Linux](#linux) · [Managing the server](#managing-the-server-on-linux) ·
[Saving memory](#saving-memory) · [Ports](#ports) · [Removing a server](#removing-a-server) · [Problems](#problems)

---

## Windows

### What you need

- Windows 10/11 or Windows Server 2019+, 64-bit
- Your Rumbleverse game folder (setup finds the one your rVclient launcher uses) or the game zip
- RAM: about 3.5 to 4 GB for each mode you run (Playground alone is the lightest)
- Disk: about 15 GB if setup copies your game files, about 1 GB if it links them
- Private server: Tailscale or Radmin VPN on your PC and your friends' PCs, same network
- Community server: a VPS or dedicated server, with **UDP 7777-7781** open in your provider's firewall (and 7877-7881 for Zero Wait)

### Steps

1. **Private server only:** in your rVclient launcher open **Server Status > My private servers >
   Set up a private server** and keep the code it shows (valid 30 minutes).
2. Download **`RVServer-Setup.zip`** from the [latest release](../../releases/latest) and extract it anywhere.
3. Double-click **`Setup-RVServer.bat`** and answer its questions:
   - which drive to put the server on (it suggests your game's drive)
   - your setup code (private) or your Discord name (community, so the admins can reach you)
   - copy or link your game files: **C** = copy (recommended), **L** = link (no extra space)
4. Accept the administrator prompt (firewall rules and optional auto-start).
5. Done.
   - **Private:** your server appears in your launcher under *My private servers*. Press **Join**.
     Friends on your Tailscale / Radmin network see it too. Use **Share...** to add friends by their rVclient name.
   - **Community:** it is registered and **waiting for approval**. Once approved it joins matchmaking by itself.

Optional: right-click **`Host-Check.ps1` > Run with PowerShell** first. It rates CPU, RAM, disk and network
and changes nothing.

Manage the server with the **rV Modes (server)** shortcut on your desktop: modes on/off, bots per match,
barge countdown (gear button), restarts, review status and updates. More details are in
[`RVServer-Setup/README.txt`](RVServer-Setup/README.txt).

---

## Linux

The server runs in a container (Docker or Podman). The game server runs under Wine; the rVclient server
software inside it is the official one and updates itself exactly as on Windows. No Windows is needed.

### What you need

- A 64-bit (x86_64) Linux VPS or server
- **Podman** or **Docker** (see step 1)
- RAM: about 3 GB for one mode, about 2.5 GB for each further mode (1.8 GB with memory sharing)
- Disk: about 25 GB free
- A public IPv4 address; **UDP 7777-7781** reachable, and 7877-7881 for Zero Wait (also in your provider's firewall, if it has one)
- Your Rumbleverse game zip (about 11 GB)

### Easiest way: from your own computer, onto a fresh VPS

[rvserver-oneclick](https://github.com/cmspam/rvserver-oneclick) sets up a whole VPS from your PC: a
Windows program (or a script for Linux, macOS and WSL) that installs Fedora CoreOS on a fresh Debian or
Ubuntu VPS, uploads your game zip and runs the installer below. You only need the VPS's root password or
SSH key, and your game zip. It erases the VPS.

### On a server you already have: the installer

The installer asks a few questions (each with a suggested answer you can accept with Enter), checks the
machine, and starts everything. Log in to your server and run these commands.

**1. Install Podman** (skip if you have Podman or Docker already):

```sh
# Debian / Ubuntu
sudo apt update && sudo apt install -y podman curl
# Fedora / RHEL / Rocky / Alma
sudo dnf install -y podman curl
```

**2. Put the game zip on the server.** From your own computer, for example:

```sh
scp Rumbleverse-client-z.zip root@YOUR-SERVER-IP:/root/
```

**3. Download and run the installer:**

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/cmspam/rvclient-community-servers/main/linux/install.sh
sudo bash install.sh
```

It asks:

1. where your game zip is (it looks in the usual places first)
2. where to keep the server's files
3. **community or private** server
4. your **Discord name** (community) or your **setup code** (private, from the launcher:
   *Server Status > My private servers > Set up a private server*)
5. your **public IP** (detected for you, press Enter)
6. which **modes** to run (it suggests how many fit in your RAM)
7. which modes get **Zero Wait**, no waiting between matches (see
   [Zero Wait](#zero-wait-no-waiting-between-matches-linux); about 2.5 GB more RAM per mode and its port + 100 open to players; it suggests
   the modes that fit, empty for none, and it can be switched per mode later on the web page)
8. whether to switch on **memory sharing** (recommended with more than one mode)
9. whether to turn on the **web admin page**

At the end it prints the web page address and the admin password. The server then unpacks the game,
registers itself and downloads the server kit. That usually takes **a few minutes** (longer on a slow
connection); it starts by itself afterwards. Run `sudo bash install.sh` again at any time to change these choices;
the server's registration and settings are kept.

### Without the installer: one command

Replace the zip path and the folder as needed, then paste:

```sh
sudo mkdir -p /srv/rvserver
sudo podman run -d --name rvserver --restart=unless-stopped --network host \
  -v /root/Rumbleverse-client-z.zip:/game.zip:ro,z \
  -v /srv/rvserver:/data:Z \
  ghcr.io/cmspam/rvclient-community-servers:latest
sudo podman logs rvserver      # shows the admin password
```

(For Docker, write `docker` instead of `podman`. The `,z` and `:Z` let the container read the files on
SELinux systems such as Fedora or RHEL; elsewhere they are ignored.)

If your Linux kernel has ntsync, also add `--device /dev/ntsync` before the image name (see
[Faster thread synchronization](#faster-thread-synchronization-ntsync)).

Then open `http://YOUR-SERVER-IP:8080`, log in with that password, choose your own password, and fill in
the short setup form. It has the same questions as the installer.

To skip the form, add the answers to the command before the image name, for example
`-e RV_EDITION=community -e RV_CONTACT=your_discord_name -e RV_MODES=solo,playground`.

| Setting | Meaning |
|---|---|
| `RV_EDITION` | `community` or `private` |
| `RV_CONTACT` | community: your Discord name |
| `RV_SETUP_CODE` | private: setup code from the launcher |
| `RV_NAME` | server name |
| `RV_MODES` | any of `solo,playground,duos,trios,squads`, or `all` |
| `RV_PUBLIC_IP` | address players connect to (detected if empty) |
| `RV_REGION` | e.g. `ap-northeast-1` (measured by ping if empty) |
| `RV_SLIM` | `off` = no RAM saving (default `on`; see [Saving memory](#saving-memory)) |
| `RV_KSM` | `on` = memory sharing between modes (see [Saving memory](#saving-memory)) |
| `RV_WEBUI` | `off` = no web admin page (use the terminal menu) |
| `RV_WEBUI_PORT` | web page port (default `8080`) |
| `RV_WEBUI_BIND` | address of the web page (default `0.0.0.0`; `127.0.0.1` = only through an SSH tunnel) |
| `RV_KIT_AUTO_UPDATE` | `off` = do not install new server kits by itself (default `on`; see Updates below) |
| `RV_KIT_UPDATE_HOURS` | hours between server kit checks (default `0.25`, every 15 minutes) |
| `RV_IMAGE_AUTO_UPDATE` | `off` = do not check for a newer container image (default on) |
| `RV_IMAGE_UPDATE_HOURS` | hours between image checks (default `1`) |
| `RV_IMAGE_UPDATE_MAX_HOURS` | restart for a new image after this many hours even with players on (default `6`) |
| `RV_SWAP` | modes with Zero Wait at the first start, e.g. `solo,duos` (see [Zero Wait](#zero-wait-no-waiting-between-matches-linux)) |
| `RV_WARM_SPARE_MIN_FREE_MB` | free memory a Zero Wait spare needs to start (default 2500) |
| `RV_BOOT_NICE` | `off` = game servers start at the normal CPU priority (default: lowest until joinable) |
| `RV_NODE_ID`, `RV_NODE_KEY` | move an existing registration to this machine |

### As a Podman Quadlet (starts at boot, updates itself)

The installer does this for you. To do it by hand, save this as `/etc/containers/systemd/rvserver.container`:

```ini
[Unit]
Description=Rumbleverse server
Wants=network-online.target
After=network-online.target

[Container]
ContainerName=rvserver
Image=ghcr.io/cmspam/rvclient-community-servers:latest
Network=host
Volume=/root/Rumbleverse-client-z.zip:/game.zip:ro,z
Volume=/srv/rvserver:/data:Z
Pull=newer
# ntsync, if the kernel has it (see "Faster thread synchronization"):
#AddDevice=/dev/ntsync
# Memory sharing between modes (also switch KSM on, see "Saving memory"):
#AddCapability=SYS_RESOURCE
#Environment=RV_KSM=on
# Optional answers instead of the web setup form:
#Environment=RV_EDITION=community RV_CONTACT=your_discord_name RV_MODES=solo,playground

[Service]
Restart=always
TimeoutStartSec=900
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
```

Then:

```sh
sudo mkdir -p /srv/rvserver
sudo systemctl daemon-reload
sudo systemctl start rvserver
sudo journalctl -u rvserver | grep -A2 "admin password"  # the admin password
```

---

## Managing the server on Linux

### Web admin page

Open `http://YOUR-SERVER-IP:8080`. It has the same controls as the Windows rV Modes app:

- your server as the rVclient backend sees it: review status, server kit version, update and roll back
- each mode: on/off, state, players, uptime, memory, restart, stop, start
- per-mode settings: bots per match, barge countdown, empty-match restart, starting stats, and the same
  switches as the Windows rV Modes app: bot navigation, removing invisible players (and its grace time),
  removing players with no clothing; also the held item fix
- restart all modes, stop or start all servers
- logs

The page uses plain HTTP and is protected by your password. On a public server, allow port 8080 only from
your own address, or run it with `-e RV_WEBUI_BIND=127.0.0.1` and open it through an SSH tunnel:
`ssh -L 8080:127.0.0.1:8080 root@YOUR-SERVER-IP`, then visit `http://127.0.0.1:8080`.

Forgot the password: `sudo podman exec rvserver rv reset-password`

### Terminal menu (over SSH)

Everything the web page does, in the terminal:

```sh
sudo podman exec -it rvserver rv menu
```

Or single commands:

```sh
sudo podman exec rvserver rv status                  # modes, players, memory
sudo podman exec rvserver rv node                    # review status, server kit version
sudo podman exec rvserver rv mode duos on            # switch a mode on or off
sudo podman exec rvserver rv restart solo            # restart / stop / start one mode
sudo podman exec rvserver rv settings solo           # show a mode's settings
sudo podman exec rvserver rv set solo SpawnBot 40    # change one (add --restart to apply now)
sudo podman exec rvserver rv set solo BotNavigation true   # on/off settings take true or false
sudo podman exec rvserver rv update                  # install the newest server kit
sudo podman exec rvserver rv logs solo 100           # last lines of a log
sudo podman exec rvserver rv leave                   # remove from the server list (before deleting)
sudo podman exec rvserver rv help                    # every command
```

### Everyday

```sh
sudo podman logs -f rvserver        # live log
sudo podman restart rvserver        # restart everything
sudo podman stop rvserver           # stop (the game servers shut down cleanly)
```

Settings: the web page and `rv settings` list the server kit's own settings (the ones the rVclient admin
panel and the Windows rV Modes app offer, with their labels, ranges and help), read from the kit itself, so
a setting a new kit adds shows up without an image update. Some more settings that Server.dll reads but the
kit does not list are offered too (end-of-match screen time, storm size, frame cap, replication options,
bot navigation radius, starting stats, held item fix), and any other key already in a `Config.<mode>.ini`
section is shown with its raw name.

Default settings: the container turns on **bot navigation** (`BotNavigation`) and the **held item fix**
(`HeldItemFix`) in every mode's `Config.<mode>.ini` when it starts, but only where the setting is not in the
file yet. A value you set yourself, also `false`, is kept: `rv set solo BotNavigation false`.

Updates: the container checks for a newer server kit (the game server software) 5 minutes after it
starts and then every 15 minutes, and installs it through the kit's own updater, the same as `rv update`.
Each mode restarts on the new kit only once it is empty (after 3 hours regardless), and the updater
rolls back by itself if a mode crashes twice in the first 10 minutes; the next check then tries the
newest kit again. Files are replaced so that a running mode keeps the old ones until it restarts
(Linux does not lock a loaded DLL the way Windows does, so overwriting it in place would freeze a
running match). `RV_KIT_AUTO_UPDATE=off` turns this off.

The container image (Wine and the tools around it) updates itself too, without cutting a match off: about
once an hour (`RV_IMAGE_UPDATE_HOURS`) the container asks the registry whether its tag points to a newer
build, and when it does, it waits until every server is empty (after 6 hours regardless,
`RV_IMAGE_UPDATE_MAX_HOURS`) and stops; the service starts it again and, with `Pull=newer` in the Quadlet
above, on the new image. Do not use `AutoUpdate=registry` / `podman-auto-update.timer` for this container:
it restarts the container as soon as a new image appears, in the middle of a match. With Docker, or without
`Pull=newer`, the container logs that it was not updated and does not try again for that build; then run
`sudo podman pull ghcr.io/cmspam/rvclient-community-servers:latest` and re-create the container (or run the
installer again). `RV_IMAGE_AUTO_UPDATE=off` turns the check off. Your data stays in the data folder.

An existing Quadlet with `AutoUpdate=registry`: replace that line with `Pull=newer`, run
`sudo systemctl daemon-reload`, and restart the server once (or run the installer again, which writes the
Quadlet anew). The installer sets up Docker as a systemd service that pulls a newer image at each start
(`docker run --pull always`), so the same updates work there.

Data folder contents: `server/` (game and server kit), `state/` (registration and web login; keep it private),
`logs/`, `wine/`. To move the server to another machine, stop it and copy the whole folder.

---

## Saving memory

### RAM saving (Linux, on by default)

The game server is the game client started without graphics and sound, and it still loads and keeps
everything a player's PC needs for them. The Linux image frees that data while the map loads:

- `rvslim.dll` (source: [`linux/src/rvslim.c`](linux/src/rvslim.c)) is listed in `DList.ini`, so the mod
  loader starts it with the server. It releases mesh render buffers, distance fields, texture and sound
  data. Collision, animation and gameplay data are not touched. It only acts on the game build it was
  made for and does nothing on any other.
- Your own `rest-api-client.dll` (part of the game files) gets a two-byte change, so its matchmaking table
  starts empty instead of holding 64 teams that a server never fills (433 MB). Only the known original
  file is changed; nothing from the game is included in this project.

Both are put back in place before every server start, so server kit updates do not undo them.
`RV_SLIM=off` turns it off and puts the original `DList.ini` entry and `rest-api-client.dll` back.

### Memory sharing between modes (KSM)

Each mode is a separate game server, and the servers hold a lot of identical memory. The kernel can keep
identical memory only once (KSM, Kernel Samepage Merging). Measured with all five modes running:

| | Neither | RAM saving | Memory sharing | Both |
|---|---|---|---|---|
| First mode | about 3.9 GB | about 2.5 GB | about 3.9 GB | about 2.5 GB |
| Each further mode | about 3.9 GB | about 2.5 GB | about 1.7 GB | about 1.8 GB |
| All five modes | about 19 GB | about 12 GB | about 11 GB | about 10 GB |

With RAM saving, memory sharing mostly helps with three modes or more.

The installer sets it up when you answer yes. By hand (Linux 6.4 or newer, container run as root):

```sh
# switch KSM on, now and after every reboot
printf 'w /sys/kernel/mm/ksm/run - - - - 1\nw /sys/kernel/mm/ksm/pages_to_scan - - - - 1000\nw /sys/kernel/mm/ksm/use_zero_pages - - - - 1\n' \
  | sudo tee /etc/tmpfiles.d/rvserver-ksm.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/rvserver-ksm.conf
```

Then start the container with `--cap-add SYS_RESOURCE -e RV_KSM=on` (Quadlet: `AddCapability=SYS_RESOURCE`
and `Environment=RV_KSM=on`). See what it saves:

```sh
echo "$(( ( $(cat /sys/kernel/mm/ksm/pages_sharing) + $(cat /sys/kernel/mm/ksm/ksm_zero_pages) ) * 4 / 1024 )) MB saved"
```

After a match a server restarts and briefly needs its full memory again until it has been merged (2 to 3
minutes). Leave some room for that: free RAM, zram (compressed swap in RAM) or a swap file.

**Windows:** the same idea is called Page Combining. Check it in PowerShell with `Get-MMAgent`, and switch
it on with `Enable-MMAgent -PageCombining` (as administrator, then restart).

---

## Better bots (Linux, off by default)

Experimental, and off by default: on a server with 2 CPUs, building the bots' paths caused short hitches
every few seconds while the bots spread out after the landing. `RV_BOTS=on` switches it on.

The battle royale bots run the game's own AI. On a server they mostly stand still or jump in place: they
see 5 m ahead, look for players only within 30 m, and their paths are built while the game runs, which
`Server.dll` limits to 2 pieces at a time, far too slow for 20 or 30 bots. The Linux image changes that
before every server start, when switched on:

- `rvbots.dll` (source: [`linux/src/rvbots.c`](linux/src/rvbots.c)) is listed in `DList.ini`. It lets bots
  look for players within 150 m, see 40 m in a 180 degree view, and go after players they have no path to
  yet. Attacks, deliberate misses, dodges and teamwork stay as the game made them. It only acts on the game
  build it was made for.
- Your own `Server.dll` (part of the server kit) gets one number changed: paths built at once, 2 to 1024
  (the engine's own default). Only when the instruction that sets it is found exactly once;
  otherwise it is left alone. Nothing from the server kit is included in this project.
- Bot navigation is switched on in each battle royale mode's config (`BotNavigation=true`,
  `BotNavRadius=100`), so it overrides the admin panel's bot navigation switch while this is on.

| Variable | Default | |
|---|---|---|
| `RV_BOTS` | `off` | `on` switches it on; off takes `rvbots.dll` out and sets `Server.dll` back to 2 (the config is left as it is) |
| `RV_BOT_NAV_JOBS` | 1024 | paths built at once |
| `RV_BOT_NAV_RADIUS` | 100 | metres around each bot that get paths |
| `RVBOTS_PLAYER_SEARCH_RADIUS` | 150 | metres in which bots look for players |
| `RVBOTS_SIGHT_RADIUS` | 40 | metres bots see |
| `RVBOTS_SIGHT_ANGLE` | 90 | degrees to each side bots see |
| `RVBOTS_KEEP_UNREACHABLE_PLAYERS` | 1 | 0 = only go after players they already have a path to |

## Add-ons (Linux)

Your own DLLs, files and small binary patches can be added to every server and stay in place through
server kit updates. Put them in the `addons` folder inside the server's data folder (in the container:
`/data/addons`, or set `RV_ADDONS_DIR`), with a list called `addons.list`:

```
# a DLL for the mod loader: copied next to the game and listed in a free DList.ini slot,
# loaded <timer> seconds after the server starts (default 20)
dll   mymod.dll  timer=20
# any other file, copied next to the game (or to= a path inside the server folder)
file  mymod.ini
# change bytes in a game file, only when it is exactly the expected version (md5 before and after);
# offsets are file offsets, bytes are hex
patch Rumbleverse/Binaries/Win64/Server.dll  from=<md5 before> to=<md5 after>  0x26aad=00040000
```

The list is applied right before each game server starts, so a change takes effect at that mode's next
start; running servers are not touched. Taking a line out undoes it at the next start: the DLL leaves
`DList.ini`, copied files are deleted, and a patched file gets its original back (kept in
`addons/.orig/`). A file that is not the expected version, for example after a kit update, is left alone
and the server log says so. `RV_ADDONS=off` skips the add-ons.

Load DLLs at least about 20 seconds after the start: loading one while the map is still loading can crash
the server.

## Faster thread synchronization (ntsync)

**Linux:** since Linux 6.14 the kernel has ntsync, which does Windows-style thread synchronization for
Wine in the kernel instead of through the wineserver process. The image's Wine uses it when the
container has `/dev/ntsync`. The installer switches it on by itself when the kernel has it. By hand:

```sh
sudo modprobe ntsync                                               # load it now
echo ntsync | sudo tee /etc/modules-load.d/rvserver-ntsync.conf    # and after every reboot
ls -l /dev/ntsync                                                  # it should exist now
```

Then start the container with `--device /dev/ntsync` (Quadlet: `AddDevice=/dev/ntsync`). To check that
the server uses it, count the wineserver's ntsync handles (more than 0 means in use):

```sh
sudo ls -l /proc/$(pgrep -x wineserver | head -1)/fd | grep -c ntsync
```

Without ntsync the server works the same way, using Wine's older method.

## Zero Wait: no waiting between matches (Linux)

A server needs a minute or more to start its next match. With Zero Wait, players queue straight into
the next match instead: a second server of the mode is already started and waiting in its lobby.

**Server kit 2026.10.10.1 and newer** have this built in as the **warm spare**, and the container uses it
as it is. Each battle royale mode with Zero Wait gets a second server, `<mode>-spare`, on the mode's port
+ 100 (Solos 7877, Duos 7879, Trios 7880, Squads 7881), with the same `Config.<mode>.ini`. Both are
ordinary game servers: each reports to the backend with its own port, and matchmaking sends players to
whichever one is in its lobby. While one plays a match or restarts after it, the other takes the next
players. Nothing is switched at the network level. Playground has no matches, so it has no spare.

- The spare's port must be open to players like the mode's own port (provider firewall, port forward).
  The installer opens 7877-7881/udp in firewalld or ufw.
- A spare only starts with 2.5 GB of free memory (`RV_WARM_SPARE_MIN_FREE_MB` changes this). Once
  started, it restarts after its matches like any server.
- Switch it per mode with the **Zero Wait** switch on the web admin page, `rv swap on <mode>` /
  `rv swap off <mode>`, or the **Warm spare server** setting. They all set `WarmSpare=true` or `false` in
  `Config.<mode>.ini`. Off: the spare closes after its current match.
- When a container first starts on such a kit, the modes that had Zero Wait before (or are listed in
  `RV_SWAP`) keep it, and the other battle royale modes get `WarmSpare=false`.
- `rv swap status` and the web page show each mode's server and its spare (port, state, players).
  `rv logs <mode>-spare` shows the spare's log.

Every game server, spare or not, starts at the lowest CPU priority (nice 19) and gets the normal
priority once it is joinable, so that a server starting next to a match does not slow the match down.
This needs the `SYS_RESOURCE` capability (the installer always adds it); `RV_BOOT_NICE=off` turns it off.

When a running container's server kit updates itself to one with the warm spare, the container restarts
once nobody is playing (or after `RV_IMAGE_UPDATE_MAX_HOURS`) and comes back with warm spares.

**Server kits before 2026.10.10.1** have no warm spare. On those the container runs Zero Wait modes as
server pairs instead: both servers use the mode's own port, the waiting one runs in a network namespace
with no route out, and a few seconds after the round is over they swap. Pairs need `Network=host`, the
capabilities `NET_ADMIN SYS_ADMIN SYS_RESOURCE`, `SecurityLabelDisable=true` (Docker:
`--cap-add NET_ADMIN --cap-add SYS_ADMIN --cap-add SYS_RESOURCE --security-opt apparmor=unconfined`) and
IP forwarding on the host (`net.ipv4.ip_forward=1`); the installer, run as root, sets all of this up.
Without them the modes run as single servers and the log says why.

## Ports

| Mode | Port |
|---|---|
| Solos | 7777/udp |
| Playground | 7778/udp |
| Duos | 7779/udp |
| Trios | 7780/udp |
| Squads | 7781/udp |
| Zero Wait spares (kit 2026.10.10.1+) | the mode's port + 100: 7877, 7879, 7880, 7881/udp |
| Linux web admin page | 8080/tcp (only for you) |

Only the modes you run need their port, and a spare's port only with Zero Wait on for that mode. Community servers must be reachable from the internet on these
ports; open them in your provider's firewall too.

---

## Removing a server

**Windows:** private servers: launcher > *Server Status > My private servers > Remove*. Any server: run
`Uninstall-RVServer.bat` in the server's folder (for example `C:\RVServer`). It asks whether to keep the files.

**Linux:**

```sh
sudo podman exec rvserver rv leave   # removes it from the server list (private servers: or Remove in the launcher)
sudo systemctl stop rvserver; sudo rm -f /etc/containers/systemd/rvserver.container; sudo systemctl daemon-reload
sudo podman rm -f rvserver
sudo rm -rf /srv/rvserver          # deletes the server's files and registration
```

---

## Problems

- **Linux: the server does not appear / stays offline.** Check the log: `sudo podman logs rvserver`.
  Right after setup, the kit download takes a while. Check that UDP 7777-7781 is open in your
  provider's firewall.
- **"SETUP STOPPED"**: the reason is on the same line. Fix it and run the setup again (Windows:
  `Setup-RVServer.bat`; Linux: the installer or the web setup form).
- **Private server: setup code refused.** Codes are valid for 30 minutes; get a new one in the launcher.
- **Not enough memory.** Switch modes off (web page, `rv mode <mode> off`, or rV Modes on Windows), or use
  memory sharing on Linux.

Questions? Ask in the rVclient Discord.

The Linux container support is a community contribution. It uses the official server software unchanged.
