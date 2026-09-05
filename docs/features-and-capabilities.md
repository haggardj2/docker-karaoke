# KaraokeDock Features and Capabilities

KaraokeDock is a self-hosted, web-based karaoke hosting system designed to run a show from a browser. It combines a singer request page, host control panel, fullscreen player, admin dashboard, local media library, online karaoke search, queue rotation, break music, and PostgreSQL-backed persistence.

## Core capabilities

### Web-based show control

- Runs from a browser with separate pages for singers, hosts, the player display, and administration.
- Uses real-time WebSocket updates so queue, playback, overlay, break music, and settings changes sync across connected devices.
- Supports mobile-first singer requests and responsive host controls for phones, tablets, laptops, TVs, and projectors.
- Provides QR-code-driven request access so guests can open the request page without typing the URL.

### Singer request page

- Lets singers search the local karaoke library by title, artist, or Disc ID.
- Supports browsing the local library by artist or title, grouped alphabetically.
- Provides filters for source, media type, and search field.
- Groups duplicate local results by song and lets singers choose a specific version when multiple versions exist.
- Supports Karaoke Nerds online search when external library access is enabled.
- Allows key adjustments per requested song.
- Tracks the singer's own active queue and lets them reorder or remove their queued requests.
- Prevents duplicate active requests for the same singer and song.
- Saves and reuses singer identity locally, including a stable singer UUID.
- Uses the signed-in local or SSO account display name/username as the request-page singer name when available.
- Supports singer history export/import with `.kd` files, including request date/time information.

### Host panel

- Provides the live control surface for running a karaoke show.
- Shows current playback state, now-playing details, queue order, singer queues, and singer history.
- Displays Disc ID tags in queue and history views.
- Shows browser-locale request timestamps for singer queue/history entries.
- Supports play, stop, next/skip, auto-play, queue management, and manual song additions.
- Lets the host reorder singers and songs, rename singers, edit key adjustments, remove queue entries, and clear the queue.
- Supports replacing queued or currently playing songs from local or online search results. Replacing the currently playing song restarts playback with the replacement.
- Provides singer history management, including export/import, rename, merge, and clearing history.
- Includes collapsible top controls for mobile space savings.
- Shows YouTube fallback download progress/errors on the host page when external playback fails.

### Player page

- Provides fullscreen playback for the show display.
- Plays local MP4 karaoke videos.
- Streams CDG+MP3 karaoke as generated MP4 playback.
- Plays external YouTube/Karaoke Nerds entries when possible.
- Automatically requests a yt-dlp local fallback download if a YouTube video fails because of restrictions or playback errors.
- Responds to host commands in real time over WebSocket.
- Supports auto-play progression and configurable delays.
- Shows configurable overlay elements such as QR code, request URL, custom messages, rotation scroller, and queue privacy options.

### Queue and rotation

- Stores queue entries with singer identity, track, status, position, key adjustment, and request timestamps.
- Tracks queue states such as queued, playing, done, skipped, removed, and cancelled.
- Maintains singer-level queue/history views and aggregate singer stats.
- Supports advanced rotation policies, including strict round robin, least recently sung, signup order, song-queue-only, manual, and hybrid rotation modes.
- Supports host/admin overrides such as moving singers, inserting a singer next, pausing/resuming rotation, and setting singer rotation status.
- Re-sorts queued songs as rotation settings or song orders change.

### Local media library

- Supports local MP4 video files.
- Supports CDG+MP3 pairs.
- Supports zipped CDG+MP3 media.
- Parses track metadata from filenames using configurable library parse modes.
- Stores artist, title, Disc ID, source, file paths, media kind, and duration metadata.
- Uses ffprobe to extract and cache media durations.
- Pre-caches zipped CDG+MP3 media for faster playback startup.
- Provides admin-managed library folders with manual scans and optional background scans.
- Detects changed media folders with directory fingerprints so background scans only run when needed.

### External karaoke and downloads

- Integrates with Karaoke Nerds search for online karaoke tracks.
- Adds external tracks directly to the queue without requiring a pre-existing local file.
- Uses yt-dlp for optional video downloads.
- Provides admin tools to check yt-dlp version, update yt-dlp, inspect video info, download videos, and scan the downloads folder.
- Imports downloaded MP4 files into the local database.
- Can scan a downloads folder on demand or in the background.
- Suppresses noisy logs when already-imported downloaded media produces no changes.
- Can convert failed YouTube playback into a downloaded local fallback and replace the current queue row.

### Break music

- Supports separate break music folders and scanning.
- Supports common audio formats including MP3, FLAC, ALAC, WAV, Opus, AAC, M4A, OGG, and OGA.
- Extracts break music metadata such as title, artist, genre, and duration.
- Provides break music search, selection, pause/resume, skip, previous, and timing sync.
- Supports active playlists and saved break music playlists.
- Writes playlist files for saved break music playlists.
- Supports crossfade, volume, and resume delay settings.
- Automatically pauses break music when karaoke playback starts and resumes it when karaoke playback ends, unless manually paused.

### Admin dashboard

- Shows system statistics such as artist count, track count, queue count, and last scan time.
- Manages local karaoke libraries and parse modes.
- Runs library scans and shows scan progress through server-sent events.
- Manages break music folders, scans, library clearing, and playlists.
- Manages public request settings, library enablement, local browse enablement, player/overlay options, auto-play, background tasks, log level, and yt-dlp options.
- Provides database clearing tools for library/queue data.
- Provides user management and account settings.
- Provides OIDC/SSO configuration and password-login fallback controls.

### Authentication and users

- Supports local username/password sessions.
- Supports OIDC/SSO login with configurable provider settings.
- Supports role-based access, including admin-only routes for sensitive operations.
- Supports account profile data such as username, display name, and picture.
- Includes password change, username change, logout, session validation, and credential reset tooling.
- Applies rate limiting to authentication, search, and queue-sensitive routes.

### Deployment and persistence

- Uses PostgreSQL for persistent data.
- Runs as a Dockerized web/API application.
- Supports Docker Compose deployments.
- Supports Unraid deployments with a separate required PostgreSQL database.
- Stores settings in the database and applies many changes live without restarting.
- Logs through stdout/stderr so container logs can be viewed with Docker or Unraid tooling.

## Main web pages

| Page | Path | Purpose |
|---|---|---|
| Request | `/` or `/requests` | Singer-facing song search, browse, request, and personal queue/history tools |
| Host | `/host` | Live show control, queue management, playback control, break music, and singer history |
| Player | `/player` | Fullscreen playback and overlay display for TV/projector output |
| Admin | `/admin` | System setup, libraries, scans, users, authentication, settings, and maintenance |

## Supported media and sources

| Type | Capability |
|---|---|
| Local MP4 | Indexed, searched, queued, and played directly |
| CDG+MP3 | Indexed as paired karaoke media and streamed as video playback |
| ZIP CDG+MP3 | Indexed from ZIP archives and pre-cached for playback |
| Karaoke Nerds / YouTube | Searchable external source with queue integration |
| yt-dlp downloads | Optional local download/import workflow and playback fallback |
| Break music audio | Separate scanned audio library with playlists and live controls |

## Real-time behavior

KaraokeDock broadcasts live updates for queue changes, player commands, overlay settings, auto-play settings, break music changes, and YouTube fallback status. This keeps the request page, host panel, player display, and admin controls aligned without requiring manual refreshes.

## Related documentation

- [Unraid setup guide](https://github.com/haggardj2/KaraokeDock/blob/main/docs/unraid_readme.md)
- [Main project README](https://github.com/haggardj2/KaraokeDock/blob/main/docs/README.md)
