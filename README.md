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
- Each game mode is its own server and needs about **4 GB of RAM** (less on Linux with memory sharing, see below).
- Server updates arrive by themselves through the rVclient backend.

**Contents:** [Windows](#windows) · [Linux](#linux) · [Managing the server](#managing-the-server-on-linux) ·
[Saving memory](#saving-memory-with-several-modes) · [Ports](#ports) · [Removing a server](#removing-a-server) · [Problems](#problems)

---

## Windows

### What you need

- Windows 10/11 or Windows Server 2019+, 64-bit
- Your Rumbleverse game folder (setup finds the one your rVclient launcher uses) or the game zip
- RAM: about 3.5 to 4 GB for each mode you run (Playground alone is the lightest)
- Disk: about 15 GB if setup copies your game files, about 1 GB if it links them
- Private server: Tailscale or Radmin VPN on your PC and your friends' PCs, same network
- Community server: a VPS or dedicated server, with **UDP 7777-7781** open in your provider's firewall

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
- RAM: about 4 GB for one mode; with memory sharing about 1.7 GB for each further mode
- Disk: about 25 GB free
- A public IPv4 address; **UDP 7777-7781** reachable (also in your provider's firewall, if it has one)
- Your Rumbleverse game zip (about 11 GB)

### Easiest way: the installer

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
7. whether to switch on **memory sharing** (recommended with more than one mode)
8. whether to turn on the **web admin page**

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
| `RV_KSM` | `on` = memory sharing between modes (see [Saving memory](#saving-memory-with-several-modes)) |
| `RV_WEBUI` | `off` = no web admin page (use the terminal menu) |
| `RV_WEBUI_PORT` | web page port (default `8080`) |
| `RV_WEBUI_BIND` | address of the web page (default `0.0.0.0`; `127.0.0.1` = only through an SSH tunnel) |
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
AutoUpdate=registry
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
sudo systemctl enable --now podman-auto-update.timer     # automatic image updates
sudo journalctl -u rvserver | grep -A2 "admin password"  # the admin password
```

---

## Managing the server on Linux

### Web admin page

Open `http://YOUR-SERVER-IP:8080`. It has the same controls as the Windows rV Modes app:

- your server as the rVclient backend sees it: review status, server kit version, update and roll back
- each mode: on/off, state, players, uptime, memory, restart, stop, start
- per-mode settings: bots per match, barge countdown, empty-match restart, starting stats
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

Updates: the server kit (the game server software) updates itself through the rVclient backend. The
container image (Wine and the tools around it) updates itself with the Quadlet above; otherwise run
`sudo podman pull ghcr.io/cmspam/rvclient-community-servers:latest` and re-create the container
(or run the installer again). Your data stays in the data folder.

Data folder contents: `server/` (game and server kit), `state/` (registration and web login; keep it private),
`logs/`, `wine/`. To move the server to another machine, stop it and copy the whole folder.

---

## Saving memory with several modes

Each mode is a separate game server, and the servers hold a lot of identical memory.

**Linux:** the kernel can keep identical memory only once (KSM, Kernel Samepage Merging). Measured with
all five modes running:

| | Without memory sharing | With memory sharing |
|---|---|---|
| All five modes | about 19 GB | about 11 GB |
| First mode | about 3.8 GB | about 3.8 GB |
| Each further mode | about 3.8 GB | about 1.7 GB |

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

## Ports

| Mode | Port |
|---|---|
| Solos | 7777/udp |
| Playground | 7778/udp |
| Duos | 7779/udp |
| Trios | 7780/udp |
| Squads | 7781/udp |
| Linux web admin page | 8080/tcp (only for you) |

Only the modes you run need their port. Community servers must be reachable from the internet on these
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
