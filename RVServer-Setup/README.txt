RUMBLEVERSE SERVER SETUP - host your own server
================================================

Two kinds of server, one setup tool:

  PRIVATE SERVER  - you + your friends. Runs on your own PC. Friends join over Tailscale or
                    Radmin VPN. Nobody else sees it, and it is never in public matchmaking.
  COMMUNITY SERVER - public. Runs on a VPS or dedicated server. After we approve it, it joins
                    matchmaking for everyone in your region, shown as "Community" in the launcher.

Setup picks the right one for you: on a home internet connection it always sets up a PRIVATE
server (public servers need a VPS or dedicated server).

WHAT YOU NEED
  - Windows 10/11 or Windows Server 2019+, 64-bit
  - YOUR OWN copy of Rumbleverse (we never provide game files). Setup finds the one your
    rVclient launcher uses.
  - RAM: about 3.5 GB for each mode you run (Playground alone is the lightest)
  - Disk: about 15 GB if setup copies your game files, about 1 GB if it links them
  - Private server: Tailscale or Radmin VPN on your PC and your friends' PCs, same network
  - Community server: UDP ports 7777-7781 open in your provider's firewall
  - The newest rVclient launcher

OPTIONAL: CHECK YOUR MACHINE FIRST (2 minutes, changes nothing)
  Right-click Host-Check.ps1 > Run with PowerShell. It rates CPU, RAM, disk and network.

SET IT UP
  1. Private server: in your rVclient launcher open Server Status > My private servers >
     "Set up a private server" and keep the code it shows (valid 30 minutes).
  2. Double-click Setup-RVServer.bat. It asks a few things:
       - which drive to put the server on (it suggests your game's drive)
       - your setup code (private) or your Discord name (community - so we can reach you)
       - Copy or link your game files:
           C = copy (recommended) - the server gets its own copy, fully separate
           L = link - no extra space, the same files on disk; the server only reads them
     Then accept the administrator prompt (firewall rules + optional auto-start).
  3. Done.
       Private: your server shows in your launcher under My private servers - press Join.
                Friends on your Tailscale / Radmin network see it there too and can pick it
                as their region. Use "Share..." to add friends by their rVclient name.
       Community: it is registered and WAITING FOR APPROVAL. Once approved it joins
                matchmaking by itself - nothing else to do.

YOUR GAME STAYS YOURS
  Setup never moves or changes your game. It keeps starting from the rVclient launcher as
  always - also while your own server is running.

MANAGING YOUR SERVER
  The "rV Modes (server)" shortcut on your desktop: switch modes on/off, bots per match and
  barge countdown (gear button), restart a mode, see your review status, update.
  Updates come by themselves - you never download server files again by hand.

REMOVING IT
  Private server: Server Status > My private servers > Remove (on the PC that runs it).
  Any server: run Uninstall-RVServer.bat in the server's folder (for example C:\RVServer).
  It asks first whether to KEEP the server installed (stopped, files kept for next time) or
  remove everything. Either way your game is checked and left normal.

HELP
  Ask in the rVclient Discord. Never share your server folder's setup-state.json - it holds
  your server's key.
