# KaraokeDock Remote Requests Gateway

Small public-facing request gateway for KaraokeDock Station. It can run on a VPS or in Docker, keeps a local SQLite copy of the Station catalog for fast public searches, accepts singer requests, and exposes token-protected Station sync endpoints.

Station polls the Gateway automatically once configured. The poll loop pulls new singer requests, applies singer queue edits, and refreshes the Gateway copy of "My Queue" without requiring an Admin-page manual sync.

## Run locally

```bash
npm install
cp .env.example .env
STATION_API_TOKEN=your-station-token npm run dev
```

The requests page is served at `http://localhost:5180`.

## Docker

```bash
docker build -t karaokedock-gateway ./Gateway
docker run -d \
  --name karaokedock-gateway \
  -p 5180:5180 \
  -v karaokedock-gateway-data:/data \
  -e STATION_API_TOKEN=your-station-token \
  -e JSON_BODY_LIMIT=50mb \
  -e PUBLIC_BASE_URL=https://requests.example.com \
  karaokedock-gateway
```

## Station integration contract

All Station endpoints require either:

```http
Authorization: Bearer <STATION_API_TOKEN>
```

or:

```http
X-Station-Token: <STATION_API_TOKEN>
```

### Catalog sync

`PUT /api/station/catalog`

```json
{
  "full": true,
  "syncId": "station-generated-sync-id",
  "chunkIndex": 0,
  "chunkCount": 1,
  "complete": true,
  "tracks": [
    {
      "id": 123,
      "title": "Amber",
      "artist": "311",
      "discId": "CC2112-063",
      "kind": "cdgmp3",
      "durationMs": 192000,
      "source": "local"
    }
  ]
}
```

Large Station libraries may be sent in multiple chunks with the same `syncId`. The Gateway prunes tracks missing from the Station catalog only when the final chunk has been received.

### Settings sync

`PUT /api/station/settings`

```json
{
  "settings": {
    "libraries.local_enabled": true,
    "libraries.external_enabled": true,
    "requests.acceptance": "local",
    "requests.local_browse_enabled": true
  }
}
```

The Gateway enforces these Station rules for public search and request submission.

### Pull pending singer requests

`GET /api/station/requests/pending?limit=50`

### Acknowledge a request after Station queues or rejects it

`POST /api/station/requests/:id/ack`

```json
{ "status": "queued", "stationQueueId": 456 }
```

or:

```json
{ "status": "rejected", "error": "Track no longer exists" }
```

### Push current queue snapshot for "My Queue"

`PUT /api/station/queue/snapshot`

```json
{
  "full": true,
  "queue": [
    {
      "stationQueueId": 456,
      "stationTrackId": 123,
      "requestedBy": "Alex",
      "singerUuid": "browser-generated-uuid",
      "status": "queued",
      "position": 4,
      "keyAdjustment": 0,
      "title": "Amber",
      "artist": "311"
    }
  ]
}
```

### Pull pending singer queue actions

`GET /api/station/queue-actions/pending?limit=50`

Actions are created when singers reorder or remove their own queued songs on the Gateway.

### Acknowledge a queue action

`POST /api/station/queue-actions/:id/ack`

```json
{ "status": "applied" }
```

or:

```json
{ "status": "rejected", "error": "Queue item is no longer queued" }
```

## Public API

- `GET /api/search?q=amber`
- `POST /api/requests`
- `GET /api/my-queue?name=Alex&singerUuid=<uuid>`
- `PATCH /api/my-queue/reorder`
- `DELETE /api/my-queue/:id`
- `GET /api/requests/:id`
