# KaraokeDock WSL Setup Guide

This guide shows how to run KaraokeDock on Windows with WSL 2, Docker, Docker Compose, and LAN access to the web UI.

KaraokeDock runs as a Docker app container plus PostgreSQL. The public app image is:

```text
haggardj2/karaokedock:latest
```

## What you need

- Windows 10 or Windows 11 with WSL 2 support
- A WSL Linux distro, such as Ubuntu
- Docker Desktop for Windows
- Karaoke media folders on either Windows or inside WSL

## 1. Install WSL 2

Open **PowerShell as Administrator** and run:

```powershell
wsl --install
```

Restart Windows if prompted.

If WSL is already installed, update it:

```powershell
wsl --update
wsl --set-default-version 2
```

Install Ubuntu if you do not already have a distro:

```powershell
wsl --install -d Ubuntu
```

Open Ubuntu from the Start menu and create your Linux username/password.

## 2. Install Docker Desktop

1. Download Docker Desktop:

   ```text
   https://www.docker.com/products/docker-desktop/
   ```

2. Install Docker Desktop.
3. Open **Docker Desktop**.
4. Go to **Settings > General** and enable **Use the WSL 2 based engine**.
5. Go to **Settings > Resources > WSL Integration**.
6. Enable integration for your Ubuntu distro.
7. Click **Apply & restart**.

Back in Ubuntu/WSL, confirm Docker works:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

## 3. Create folders

Inside WSL, create an app folder:

```bash
mkdir -p ~/karaokedock
cd ~/karaokedock
```

Create folders for database, downloads, and optional media:

```bash
mkdir -p ~/karaokedock/db
mkdir -p ~/karaokedock/downloads
mkdir -p ~/karaokedock/breakmusic
mkdir -p ~/karaokedock/karaoke
```

You can also use Windows folders from WSL. For example:

```text
/mnt/c/Karaoke/Karaoke Tracks
/mnt/c/Karaoke/downloads
/mnt/c/Karaoke/Break Music
```

WSL-native paths usually perform better than `/mnt/c/...`, but Windows paths are convenient if your media is already on a Windows drive.

## 4. Download the Compose files

From `~/karaokedock`:

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/haggardj2/KaraokeDock/refs/heads/main/docker-compose.yml
curl -o .env.example https://raw.githubusercontent.com/haggardj2/KaraokeDock/refs/heads/main/.env.example
cp .env.example .env
```

## 5. Find your Windows LAN IP

KaraokeDock should advertise the Windows host LAN IP, not the internal WSL IP. I highly recommend that you set you set your Windows machine with a static IP if possible and not rely on DHCP. This can normally be done within your routers DHCP settings or by manually setting the active interface to a static address. 

In PowerShell:

```powershell
ipconfig
```

Find your active network adapter and note the **IPv4 Address**, for example:

```text
192.168.1.50
```

## 6. Edit `.env`

In WSL:

```bash
nano ~/karaokedock/.env
```

Example using WSL-native media folders:

```env
POSTGRES_DB=karaoke
POSTGRES_USER=karaoke
POSTGRES_PASSWORD=change_this_password
DB_PATH=/home/YOUR_WSL_USER/karaokedock/db
DB_PORT=5432

APP_PORT=5173
MEDIA_ROOT=/media
KARAOKE_PATH=/home/YOUR_WSL_USER/karaokedock/karaoke
DOWNLOADS_PATH=/home/YOUR_WSL_USER/karaokedock/downloads
BREAKMUSIC_PATH=/home/YOUR_WSL_USER/karaokedock/breakmusic

WEB_APP_URL=http://192.168.1.50:5173
ORIGIN=http://192.168.1.50:5173,http://localhost:5173,http://127.0.0.1:5173
TRUST_PROXY=1
```

Replace:

- `YOUR_WSL_USER` with your WSL username.
- `192.168.1.50` with your Windows LAN IP.
- `change_this_password` with a strong PostgreSQL password.

Example using Windows media folders:

```env
KARAOKE_PATH=/mnt/c/Karaoke/Karaoke Tracks
DOWNLOADS_PATH=/mnt/c/Karaoke/downloads
BREAKMUSIC_PATH=/mnt/c/Karaoke/Break Music
```

## 7. Start KaraokeDock

From WSL:

```bash
cd ~/karaokedock
docker compose up -d
```

Check status:

```bash
docker compose ps
```

You should see:

```text
karaokedock
karaokedock-db
```

Check logs:

```bash
docker compose logs -f karaokedock
```

On the Windows host, open:

```text
http://localhost:5173
```

## 8. Allow LAN devices to connect

WSL 2 runs behind a virtual network. Even if `localhost:5173` works on Windows, other LAN devices may not reach it until Windows forwards the port to WSL and allows the firewall rule.

### Option A: Windows port proxy

Use this option for the most compatible setup.

In WSL, get the WSL IP:

```bash
hostname -I | awk '{print $1}'
```

Example output:

```text
172.28.205.123
```

Open **PowerShell as Administrator** and replace `172.28.205.123` with your WSL IP:

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=172.28.205.123 connectport=5173
New-NetFirewallRule -DisplayName "KaraokeDock Web 5173" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173
```

From another device on your LAN, open:

```text
http://WINDOWS_LAN_IP:5173
```

Example:

```text
http://192.168.1.50:5173
```

### Refresh the port proxy after WSL restarts

The WSL IP can change after rebooting Windows or restarting WSL. If LAN access stops working, refresh the port proxy.

In PowerShell as Administrator:

```powershell
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5173
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=$wslIp connectport=5173
```

To view current port proxy rules:

```powershell
netsh interface portproxy show all
```

To remove the rule:

```powershell
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5173
```

### Option B: WSL mirrored networking (Recommended)

Newer WSL versions support mirrored networking, which can make LAN access easier.

Create or edit this Windows file:

```text
C:\Users\YOUR_WINDOWS_USER\.wslconfig
```

Add:

```ini
[wsl2]
networkingMode=mirrored
localhostForwarding=true
```

Then restart WSL from PowerShell:

```powershell
wsl --shutdown
```

Start Ubuntu again, then start KaraokeDock:

```bash
cd ~/karaokedock
docker compose up -d
```

You may still need the Windows firewall rule:

```powershell
New-NetFirewallRule -DisplayName "KaraokeDock Web 5173" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173
```

If mirrored networking does not work on your Windows/WSL version, use **Option A: Windows port proxy**.

## 9. First login and setup

Open the Admin page:

```text
http://WINDOWS_LAN_IP:5173/admin
```

Check the container logs for the generated initial password:

```bash
docker compose logs karaokedock
```

After logging in:

1. Add or verify your karaoke library path.
2. Run a library scan.
3. Open the Host page:

   ```text
   http://WINDOWS_LAN_IP:5173/host
   ```

4. Open the Player page on the display machine:

   ```text
   http://WINDOWS_LAN_IP:5173/player
   ```

5. Singers use:

   ```text
   http://WINDOWS_LAN_IP:5173/
   ```

## Common commands

Start:

```bash
docker compose up -d
```

Stop:

```bash
docker compose down
```

Update:

```bash
docker compose pull
docker compose up -d
```

Logs:

```bash
docker compose logs -f
```

Restart only the app:

```bash
docker compose restart app
```

## Troubleshooting

### Windows can open localhost, but LAN devices cannot connect

Check:

- The Windows firewall rule exists for TCP port `5173`.
- The port proxy points to the current WSL IP.
- You are using the Windows LAN IP, not the WSL IP, from other devices.
- `.env` uses the Windows LAN IP in `WEB_APP_URL` and `ORIGIN`.

### Queue updates or WebSockets do not work from LAN devices

Make sure `ORIGIN` includes the exact browser URL:

```env
ORIGIN=http://192.168.1.50:5173,http://localhost:5173,http://127.0.0.1:5173
```

Restart after changing `.env`:

```bash
docker compose up -d
```

### Media scan finds no files

Check:

- The path in `.env` exists inside WSL.
- The Docker volume path points to the folder that contains your media.
- Windows paths are written as `/mnt/c/...`, not `C:\...`.
- The files are MP4, CDG+MP3, or zipped CDG+MP3.

### PostgreSQL fails to start

Check:

- `POSTGRES_PASSWORD` is set.
- `DB_PATH` exists and is writable.
- Port `5432` is not already used by another PostgreSQL service.

### Port proxy points to the wrong WSL IP

Refresh it:

```powershell
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5173
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=$wslIp connectport=5173
```
