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
- Each game mode is its own server and needs about **4 GB of RAM**.
- Server updates arrive by themselves through the rVclient backend.

**Contents:** [Windows](#windows) · [Linux](#linux) · [Managing the server](#managing-the-server-on-linux) ·
[Memory sharing](#memory-sharing-between-modes-ksm) · [Ports](#ports) · [Removing a server](#removing-a-server) · [Problems](#problems)

---

## Windows

### What you need

- Windows 10/11 or Windows Server 2019+, 64-bit
- Your Rumbleverse game folder (setup finds the one your rVclient launcher uses) or the game zip
- RAM: about 3.5 to 4 GB for each mode you run (Playground alone is the lightest)
- Disk: about 15 GB if setup copies your game files, about 1 GB if it links them
- Private server: Tailscale or Radmin VPN on your PC and your friends' PCs, same network
- Community server: a VPS or dedicated server, with **UDP 7777-7781** open in your provider's firewall (and 7877-7881 if you choose the warm spare method)

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
- A public IPv4 address; **UDP 7777-7781** reachable, and 7877-7881 with the warm spare method (also in your provider's firewall, if it has one)
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
7. which modes get **Zero Wait**, no waiting between matches, and which method it uses (see
   [Zero Wait](#zero-wait-no-waiting-between-matches-linux); about 2.5 GB more RAM per mode. The
   default method is server pairs; the warm spare method also needs the mode's port + 100 open to
   players. It suggests the modes that fit, empty for none, and both the method and the modes can be
   changed later on the web page)
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
| `RV_KSM` | `on` = memory sharing between modes (see [Memory sharing](#memory-sharing-between-modes-ksm)) |
| `RV_WEBUI` | `off` = no web admin page (use the terminal menu) |
| `RV_WEBUI_PORT` | web page port (default `8080`) |
| `RV_WEBUI_BIND` | address of the web page (default `0.0.0.0`; `127.0.0.1` = only through an SSH tunnel) |
| `RV_KIT_AUTO_UPDATE` | `off` = do not install new server kits by itself (default `on`; see Updates below) |
| `RV_KIT_UPDATE_HOURS` | hours between server kit checks (default `0.25`, every 15 minutes) |
| `RV_IMAGE_AUTO_UPDATE` | `off` = do not check for a newer container image (default on) |
| `RV_IMAGE_UPDATE_HOURS` | hours between image checks (default `1`) |
| `RV_IMAGE_UPDATE_MAX_HOURS` | restart for a new image after this many hours even with players on (default `6`) |
| `RV_SWAP` | modes with Zero Wait at the first start, e.g. `solo,duos` (see [Zero Wait](#zero-wait-no-waiting-between-matches-linux)) |
| `RV_ZEROWAIT` | `pairs` (default) or `spare`: the Zero Wait method at the first start |
| `RV_ZEROWAIT_APPLY_MAX_MIN` | a method change waits this many minutes for every server to be empty (default `30`) |
| `RV_SWAP_UPLOAD_WAIT_SEC` | server pairs: wait this long after the last match report was queued for the upload confirmation (default `20`) |
| `RV_SWAP_ROUND_END_QUIET_SEC` | server pairs: swap this long after the round when no match reports are queued (default `6`) |
| `RV_BOOT_NICE` | `off` = game servers start at the normal CPU priority (default: lowest until joinable) |
| `RV_BOOT_WATCHDOG` | `off` = do not end a game server start that froze or stalled (default `on`) |
| `RV_BOOT_FROZEN_SEC` | a start whose process is stopped this long is ended and started again (default `15`) |
| `RV_BOOT_STALL_SEC` | a start whose log gets no new lines for this long is ended and started again (default `150`) |
| `RV_WARM_SPARE_MIN_FREE_MB` | free memory a Zero Wait spare needs to start (default 2500) |
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
# Memory sharing between modes (also switch KSM on, see "Memory sharing between modes"):
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
  switches as the Windows rV Modes app: the better bots (hunting and fighting, hunt range, dodge chance,
  climbing), removing invisible players (and its grace time), removing players with no clothing; also the
  held item fix and the rest of the bots' switches (water guard, rescue, loot errands, cannon aim,
  springboards, log lines)
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
sudo podman exec rvserver rv set solo SweatyBots true       # on/off settings take true or false
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
starting stats, held item fix, and the better bots' own switches below), and any other key already in a
`Config.<mode>.ini` section is shown with its raw name.

Default settings: the container turns on **the better bots** (`SweatyBots`) and the **held item fix**
(`HeldItemFix`) in every mode's `Config.<mode>.ini` when it starts, but only where the setting is not in the
file yet. A value you set yourself, also `false`, is kept: `rv set solo SweatyBots false`. On kit
2026.10.14.1 and newer the old `BotNavigation` line is not read any more (the kit itself uses SweatyBots);
a line left in a config from before can be deleted by hand.

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

## Memory sharing between modes (KSM)

Each mode is a separate game server, and the servers hold a lot of identical memory. The kernel can keep
identical memory only once (KSM, Kernel Samepage Merging). Measured with all five modes running:

| | Without | With memory sharing |
|---|---|---|
| First mode | about 3.9 GB | about 3.9 GB |
| Each further mode | about 3.9 GB | about 1.7 GB |
| All five modes | about 19 GB | about 11 GB |

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
the next match instead: a second server of the mode keeps the next match ready.

There are two ways to do this. The whole server uses one method, chosen by its operator.

| Method | Ports | Who switches |
|---|---|---|
| **Server pairs** (default for this release) | the mode's own port | this container |
| **Warm spare** | the mode's port and the mode's port + 100 | the server kit and the backend |

**Server pairs** start two game servers of the mode on the mode's own port, each in its own network
namespace. Only one of them is connected to the backend at a time; the container forwards the public
UDP port to the active one. A few seconds after a round ends, once Server.dll confirms that the
match reports reached the backend (`[STATS] match reports posted`), the container switches the port
to the second server, and the first one restarts and waits. The backend sees one server per mode the
whole time. This method needs `Network=host`, the capabilities `NET_ADMIN SYS_ADMIN SYS_RESOURCE`,
`SecurityLabelDisable=true` (Docker: `--cap-add NET_ADMIN --cap-add SYS_ADMIN --cap-add SYS_RESOURCE
--security-opt apparmor=unconfined`), a default route, and IP forwarding on the host
(`net.ipv4.ip_forward=1`). The installer, run as root, sets all of this up. If any of it is missing,
the container uses the warm spare when the kit has it, and says so in the log and on the web page.

**The warm spare** is the server kit's own method (kit 2026.10.10.1 and newer). Each battle royale
mode gets a second server, `<mode>-spare`, on the mode's port + 100 (Solos 7877, Duos 7879, Trios
7880, Squads 7881), with the same `Config.<mode>.ini`. Both are ordinary game servers: each reports
to the backend with its own port, and matchmaking sends players to whichever one is in its lobby.
Nothing is switched at the network level. The spare's port must be open to players like the mode's
own port (provider firewall, port forward); the installer opens 7877-7881/udp. A spare only starts
with 2.5 GB of free memory (`RV_WARM_SPARE_MIN_FREE_MB` changes this).

### Choosing the method

- On the web admin page, use the **Zero Wait method** selector; in a terminal use
  `rv swap method pairs|spare`.
- On a server's first start the method comes from `RV_ZEROWAIT=pairs|spare`. The default for this
  release is `pairs`; it can change to `spare` in a later release.
- A change applies when every game server is empty, or after 30 minutes at most
  (`RV_ZEROWAIT_APPLY_MAX_MIN`). The page and `rv swap status` show when a change is pending. The
  container restarts to apply it, so it needs a restart policy (`Restart=always`,
  `--restart=unless-stopped`).
- Per mode, the **Zero Wait** switch on the web page, or `rv swap on|off <mode>`, chooses which
  battle royale modes have it. Playground has no matches to wait between and is not offered.
- `rv swap status` shows the method and each mode's two servers. `rv logs <mode>-spare` shows a warm
  spare's log.

In the warm spare method, the kit's **Warm spare server** setting works as before and sets
`WarmSpare` in `Config.<mode>.ini`. In the server pairs method that setting is hidden, because the
pair controller owns the choice.

Every game server, spare or not, starts at the lowest CPU priority (nice 19) and gets the normal
priority once it is joinable, so that a server starting next to a match does not slow the match down.
This needs the `SYS_RESOURCE` capability (the installer always adds it); `RV_BOOT_NICE=off` turns it off.

Existing servers that ran warm spares switch to server pairs on the first start of this image and
keep the modes they had chosen. A server that asks for the warm spare on an older kit runs server
pairs until a kit update brings the warm spare.

## Better bots (SweatyBots)

Server kit **2026.10.14.1 and newer** ships SweatyBots, the new bot brain by MCha, and no longer has the old
`BotNavigation`. The bots stop being limited to flat ground: the walkable ground is built once for the play
area before the match instead of around every bot as it moves, and the bots loot, hunt, climb walls and
buildings, follow a player onto the roofs, use the springboards, and keep out of deep water and the storm.
A bot is only ever moved when no real player is within 50 m, so nobody sees one teleport.

It is on by default, and off (`SweatyBots=false`) gives the plain game bots. The web page and
`rv settings <mode>` offer five of its switches with the kit's own texts: `SweatyBots` (the whole thing),
`SweatyBotsFight`, `SweatyBotsHuntRangeM`, `SweatyBotsDodgeChance` and `SweatyBotsClimb`. This image adds
the rest of the feature switches, for turning one part off without turning the bots off:
`SweatyBotsSafety` (the water guard and the water rescue), `SweatyBotsRescue` (a stuck bot, or one left
outside the ring), `SweatyBotsErrands` (climbing to a rooftop's rare boxes when a bot has nothing to do),
`SweatyBotsLaunchAim` (the cannon aims each bot at loot), `SweatyBotsBouncers` (the springboards),
`SweatyBotsNavGeom`, `SweatyBotsNavGeomInstanced`, `SweatyBotsNavLinks` and `SweatyBotsNavNoWater`
(the walk mesh on buildings, rocks, roof edges and out of the water), `SweatyBotsOwnInvoker` (mesh
around a bot outside the ring), `SweatyBotsClimbStopPath` (the earlier climb behavior) and
`SweatyBotsProbe` (the bots' own evidence lines in the log). The two build-job counts,
`SweatyBotsNavJobs` and `SweatyBotsNavJobsBuild`, are there for a small VPS: a large value hitches a
2-core host.

## Ports

| Mode | Port |
|---|---|
| Solos | 7777/udp |
| Playground | 7778/udp |
| Duos | 7779/udp |
| Trios | 7780/udp |
| Squads | 7781/udp |
| Zero Wait warm spare method (kit 2026.10.10.2+) | the mode's port + 100: 7877, 7879, 7880, 7881/udp |
| Linux web admin page | 8080/tcp (only for you) |

Only the modes you run need their port, and a spare's port only with the warm spare method and Zero Wait on for that mode. Community servers must be reachable from the internet on these
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
- **A mode stays "starting" for minutes.** The container watches every start until the kit reports the
  server joinable: a process stopped for 15 s, or a log with no new lines for 150 s, is ended so the
  supervisor starts it again (a start that hangs usually never finishes). `RV_BOOT_FROZEN_SEC` and
  `RV_BOOT_STALL_SEC` change the two times, `RV_BOOT_WATCHDOG=off` turns the watching off.

Questions? Ask in the rVclient Discord.

The Linux container support is a community contribution. It uses the official server software unchanged.
