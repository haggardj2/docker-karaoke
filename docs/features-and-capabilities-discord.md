Looking for testers!!

It's been a bit since I've last given an update on my Karaoke project. docker-karaoke is now **KaraokeDock**.


# KaraokeDock Features

KaraokeDock is a self-hosted web karaoke system with singer requests, host controls, fullscreen player output, admin tools, local media scanning, online search, queue rotation, break music, and PostgreSQL persistence.

[Public repo](https://github.com/haggardj2/KaraokeDock)
Docker image: `haggardj2/karaokedock:latest`

## Main features

- Mobile singer requests with QR-code access.
- Real-time queue, playback, overlay, and break music sync.
- Local MP4, CDG+MP3, and zipped CDG+MP3 support.
- Search by title, artist, or Disc ID.
- Karaoke Nerds online search and queue integration.
- yt-dlp downloads and YouTube playback fallback.
- Advanced queue rotation modes.
- Host controls for play, stop, skip, auto-play, reorder, rename, remove, and replace song.
- Singer queue and history tracking with `.kd` import/export.
- Key adjustment support per request.
- Break music playlists, volume, crossfade, and auto pause/resume.
- Fullscreen player with overlay, QR code, request URL, and rotation scroller.
- Admin dashboard for libraries, scans, users, settings, OIDC/SSO config, yt-dlp, and maintenance.
- Local login plus OIDC/SSO support.
- Docker Compose and Unraid CA friendly deployment.

## Deployment

KaraokeDock runs as a Dockerized app/API container and requires PostgreSQL. See the [readme](https://github.com/haggardj2/KaraokeDock) or Unraid [guide](https://github.com/haggardj2/KaraokeDock/blob/main/docs/unraid_readme.md).
