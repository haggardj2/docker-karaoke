# KaraokeDock Station

KaraokeDock Station is the desktop/AppImage wrapper for running the existing KaraokeDock web/API stack as a local Linux application.

## What this first scaffold provides

- Electron desktop shell for the existing Host/Admin/Requests UI.
- Managed Player window that can be moved to another display and toggled fullscreen.
- AppImage packaging configuration through `electron-builder`.
- Managed local PostgreSQL data, runtime config, and logs under the Electron user data directory.
- The existing server and built web UI are packaged as AppImage resources.

## Current limitations

This is still an early Station build. It now manages a local PostgreSQL data directory and can sync with the Remote Requests Gateway, but database backup/upload and first-run setup are still future pieces.

## Development

From this folder:

```sh
npm install
npm run stage:postgres
npm run dev
```

`npm run dev` builds the React web app into `Station/.build/web-dist`, compiles the Electron main process, starts the managed local PostgreSQL database, starts the existing API server, and opens the Station Host window.

The Station config file is created automatically at Electron's user data path. On Linux this is normally:

```text
~/.config/KaraokeDock Station/station.config.json
```

Minimum useful config:

```json
{
  "port": 5174,
  "bindHost": "0.0.0.0",
  "managedDatabase": true,
  "postgresPort": 55432,
  "databaseName": "karaokedock",
  "databaseUser": "karaokedock",
  "databaseUrl": "",
  "mediaRoot": "/",
  "allowedOrigins": [],
  "allowedNetworks": [],
  "runMigrations": false
}
```

Leave `databaseUrl` empty to use Station's managed local PostgreSQL. Set `databaseUrl` only when you intentionally want to use an external database.

`mediaRoot` defaults to `/` so Station can play files from local paths such as `/mnt/nas/...`. Set it to a narrower parent folder if you want to restrict media file access.

`bindHost` and `allowedNetworks` are read from `station.config.json`. Set `bindHost` to `0.0.0.0` to listen on LAN interfaces, then add the LAN CIDR ranges you want to allow, such as `"allowedNetworks": ["192.168.100.0/24"]`, for CORS and WebSockets. PostgreSQL remains bound to `127.0.0.1`.

YouTube fallback downloads and saved break-music playlists are stored under the Station user data directory by default:

```text
~/.config/KaraokeDock Station/downloads
~/.config/KaraokeDock Station/playlists
```

On startup, Station rewrites old container defaults (`/media/downloads` and `/media/playlists`) to those writable folders.

When Station creates the first admin account, it writes the generated credentials to:

```text
~/.config/KaraokeDock Station/bootstrap-admin.json
```

The app also shows these credentials in a startup dialog with a **Copy Password** button. The file is created with user-only permissions; delete it after changing the admin password.

## Remote Requests Gateway

Configure the Gateway from **Admin → Remote Requests Gateway**. Station stores the Gateway URL, the shared API token, and an auto-sync poll interval. The poller pushes Station library/request availability rules, pulls new singer requests, applies Gateway-side queue reorder/remove actions, and refreshes the Gateway "My Queue" snapshot automatically.

## AppImage build

Install dependencies for the existing server and web app first:

```sh
npm --prefix ../src/server install
npm --prefix ../src/web install
npm install
npm run dist:appimage
```

`npm run dist:appimage` stages PostgreSQL into `Station/.build/postgres` and FFmpeg into `Station/.build/ffmpeg` before packaging.

PostgreSQL staging uses one of:

- `PG_BINDIR`, `PG_SHAREDIR`, and optional `PG_PKGLIBDIR`
- `pg_config`
- Fedora `dnf download` as a fallback

FFmpeg staging first looks for a local `ffmpeg`/`ffprobe` that includes the `rubberband` filter, then copies those binaries plus their non-core shared libraries into the AppImage. Override with:

- `FFMPEG_SOURCE_DIR=/path/to/ffmpeg-prefix` for a local prefix containing `bin/ffmpeg`, `bin/ffprobe`, and `lib/`
- `FFMPEG_IMAGE=your-image:tag` for a compatible image with `/opt/ffmpeg`

The staged FFmpeg is validated for the `rubberband` filter required by pitch control.

The AppImage is written to:

```text
Station/release/
```

## Next build pieces

1. Add first-run setup for media, break music, downloads, and database configuration.
2. Add database backup/upload tooling.
