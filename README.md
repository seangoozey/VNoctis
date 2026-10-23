<div align="center">

# 🎴 VNoctis Manager

**Self-hosted visual novel library manager & web player**

[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://www.python.org/)

</div>

---

## Independently maintained fork

This is [seangoozey's VNoctis fork](https://github.com/seangoozey/VNoctis), based on
[starrlord/VNoctis](https://github.com/starrlord/VNoctis). The VNoctis name is retained.
`main` contains the integrated save sync, backups, offline/cache, compatibility
and background-job work. New development branches start from this repository's
`main`. See [fork development and migration](docs/fork-development.md).

## 📖 Overview

**VNoctis Manager** is a self-hosted, Docker-based web application for managing, building, and playing [Ren'Py](https://www.renpy.org/) visual novels directly in your browser. Point it at a directory of Ren'Py games and get a **Netflix-style browsable library** enriched with metadata from [VNDB](https://vndb.org/), one-click WebAssembly builds, and an in-browser player — all behind a single `docker compose up`.

---

## 📸 Screenshots

These screenshots show the original interface. Dashboard, Jobs and save backup controls are described below.

| | |
|:---:|:---:|
| <img src="extras/screenshots/1-gallery-view.png" width="460" alt="Gallery View"> | <img src="extras/screenshots/2a-import-game.png" width="460" alt="Import Game"> |
| **Gallery View** — Browse your library in a responsive card grid | **Import Game** — Upload an archive or paste a URL |
| <img src="extras/screenshots/2b-extracting-game.png" width="460" alt="Extracting Game"> | <img src="extras/screenshots/3-edit-metadata.png" width="460" alt="Edit Metadata"> |
| **Extracting Game** — Real-time progress during extraction | **Edit Metadata** — Manually edit or refresh from VNDB / Steam |
| <img src="extras/screenshots/4-view-game-details.png" width="460" alt="View Game Details"> | <img src="extras/screenshots/5a-building-game.png" width="460" alt="Building Game"> |
| **View Game Details** — Cover art, synopsis, tags, screenshots | **Building Game** — Live log streaming during WebAssembly build |
| <img src="extras/screenshots/5b-building-game.png" width="460" alt="Build Queue"> | <img src="extras/screenshots/6-loading-game.png" width="460" alt="Loading Game"> |
| **Build Queue** — Progress and queue status | **Loading Game** — In-browser player loading a compiled VN |
---

## ✨ Features

- **Game Library** — Responsive card grid with banner-style cover images, skeleton loading states, and automatic discovery of new games via file watcher
- **Search & Filter** — Client-side search by title, filter by rating / build status / metadata source / tags, sort by title / rating / release date / date added / last built
- **Pagination** — Page-based navigation with prev/next controls, ellipsis compression for large libraries, "Show All" toggle, and responsive sibling-window that tightens on mobile
- **Favorite Games** — Mark games as favorites with a ❤️ heart icon on library cards, gallery cards, and detail modals; per-user favorites persist across devices via the database; each user maintains their own favorites list; filter the library to show favorites only via a pill badge in the sort bar; the gallery displays a dedicated "❤️ My Favorites" category row scoped to the logged-in user
- **Hide / Unhide Games** — Hide games from the library view via a hover icon on cards or a button in the detail modal; hidden count shown as a pill badge in the sort bar with one-click toggle to reveal hidden items; "Unhide All" button to restore all hidden games at once
- **VNDB Integration** — Fuzzy-matches game directories to VNDB entries and fetches cover art, synopsis, ratings, developer, tags, screenshots, release date, and estimated play time
- **Steam Integration** — Search the Steam catalog by name (games + DLC), link any game to a Steam app ID, and pull cover art (library capsule), description, developer, release date, genres, screenshots, and Metacritic score; locally-cached app list refreshes every 24 hours
- **Background Imports and Builds** — Accepted imports and builds continue after closing the launcher. An admin Jobs page provides persisted progress, cancellation, retries and retained logs with reconnecting delivery and full downloads. See [background jobs](docs/background-jobs.md) for recovery and deployment details.
- **Image Compression** — Automatic lossy recompression of JPEG, PNG, and WebP images during web builds using a symlink overlay — original game files are never modified, unchanged optimized images can be reused on rebuilds; size savings depend on the game
- **Pre-built ZIP Import** — Drop a pre-built web distribution `.zip` into a game directory and the scanner auto-detects, extracts, and marks it as built — no rebuild needed; a **"Mark as Playable"** fallback button lets you bypass the build system entirely for manually extracted web builds
- **Game Import via UI** — Upload a `.zip`, `.tar.bz2`, or `.rar` game archive or paste a remote URL — with resumable file uploads, confirmed-byte progress, drag-and-drop, and automatic extraction into the games directory
- **Save Sync and History** — Per-user/per-game progress, offline recovery, retained save versions and restore controls; see [save synchronization](docs/save-sync.md).
- **Save Backups** — Reimportable VNoctis snapshot ZIPs, personal bulk backups and reviewed administrator migrations across users, including games not yet installed.
- **Game Caching and Offline Preparation** — Reuse downloaded game assets and manage per-account offline preparation from the dashboard; see [download storage](docs/game-download-storage.md).
- **In-Browser Player** — Full-screen iframe player with chrome bar, orientation hints for mobile, and save synchronization notices; on iOS (iPhone/iPad) the chrome bar is replaced with a minimal floating "← Library" pill overlay that auto-fades to maximise gameplay viewport
- **Metadata Management** — Edit metadata manually, refresh from VNDB or Steam, force-link or unlink VNDB / Steam IDs via tabbed search with autocomplete, custom covers via URL
- **Dark / Light Theme** — System-aware theme toggle with manual override, animated star-field background on build screens and library (dark mode), fully responsive from mobile to desktop
- **Multi-User Authentication** — Database-backed user accounts with bcrypt password hashing, two roles (`admin` / `viewer`), persistent JWT sessions with `userId` + `role`, automatic session validation, login rate limiting, and an admin user management panel for creating, editing, and deleting accounts
- **User Management Panel** — Admin-only page for managing user accounts: create users with username/password/role, change roles (admin ↔ viewer), reset passwords, and delete accounts with cascading favorite and save cleanup; safety guards prevent deleting yourself or demoting the last admin
- **Progressive Downloads** — Automatically generates `progressive_download.txt` rules so GUI images load upfront while game art, music, and voice stream on demand — existing rules in a game directory are preserved
- **Responsive Startup** — Verified Ren'Py web builds show interface-preparation progress and yield between screen batches. Loading avoids chained-timer throttling in hidden desktop tabs; mobile suspension still applies. Existing games need rebuilding. See [browser startup](docs/web-startup.md).
- **Custom Loading Screen** — Branded web presplash image automatically replaces the default Ren'Py loading screen in all web builds
- **Cloudflare R2 Publishing** — One-click publish of built web games to Cloudflare R2 object storage with real-time SSE progress streaming, automatic static gallery generation (self-contained HTML with integrated in-browser player), publish status badges on all cards, per-game unpublish, and an admin settings modal for credentials (AES-256-GCM encrypted at rest)
- **Docker-Native** — Three-service Compose stack with health checks, builder resource limits, network isolation, and bind-mounted persistent data; a legacy standalone build file uses named volumes

---

## 🏗️ Architecture

The stack consists of three Docker services communicating over an internal bridge network:

```text
Browser → vnm-ui (Nginx :80) → vnm-api (Fastify :3001) → vnm-builder (FastAPI :3002)
```

Default mounts in `compose.yml`:

| Container path | API | Builder | UI | Persistent host location |
|---|---|---|---|---|
| `/games` | read/write | read/write | — | `${VNM_ROOT}/games` |
| `/web-builds` | read/write | read/write | read-only | `${VNM_ROOT}/web-builds` |
| `/data` | read/write | logs subdirectory only | — | `${VNM_ROOT}/data` |
| `/renpy-sdk` | — | read/write | — | `${VNM_ROOT}/renpy-sdk` |
| `/covers`, `/screenshots` | read/write | — | read-only | Corresponding folders under `${VNM_ROOT}` |

Build overlays protect source files from SDK writes; mount permissions also allow
imports, publication and administrative deletion. The SDK mount must be writable
for downloads and the engine's generated files. Only the UI port is published.

| Service | Stack | Role |
|---|---|---|
| **vnm-ui** | React 19 · Vite 6 · Tailwind CSS v4 · Nginx | SPA frontend — library page, game detail modals, search/filter/sort, in-browser player |
| **vnm-api** | Node.js 24 · Fastify 5 · Prisma · SQLite | REST API — game scanning, VNDB & Steam metadata enrichment, cover & screenshot caching, durable job orchestration, save sync/history/backups and authenticated log reads |
| **vnm-builder** | Python 3.11 · FastAPI | Build service — Ren'Py SDK `web_build`, persistent build queue, disposable overlays and CPU-aware asset optimization |

---

## 🚀 Quick Start

### Prerequisites

- **Docker Engine 24+** and **Docker Compose v2**.
- A host directory for games and persistent application data.
- Ren'Py game directories containing a `game/` subdirectory or a bundled `renpy/`
  engine, or supported archives to import through the UI.
- **HTTPS or localhost** for service-worker caching and offline preparation.
  Physical mobile/Safari acceptance remains pending; automated mobile checks use
  Chrome viewport layouts.

The builder downloads the configured Ren'Py SDK and web platform on first start
(default `8.5.2`) into `${VNM_ROOT}/renpy-sdk`, mounted at `/renpy-sdk` in the
container. A first build therefore needs network access and sufficient disk space.

### Configure

```bash
git clone https://github.com/seangoozey/VNoctis.git
cd VNoctis
cp .env.example .env
# Edit .env: set VNM_ROOT, VNM_ADMIN_PASSWORD and appropriate PUID/PGID values.
```

Keep `.env` and runtime data out of Git.

### Build from source

This works without published registry images and builds the checked-out version.
The overlay preserves the base file's data mounts:

```bash
docker compose -f compose.yml -f compose.build.yml config --quiet
docker compose -f compose.yml -f compose.build.yml up -d --build
```

### Use published images

Use this after the fork's [Docker Images workflow](https://github.com/seangoozey/VNoctis/actions/workflows/docker-images.yml)
has successfully published accessible packages:

```bash
docker compose pull
docker compose up -d
```

Defaults are `ghcr.io/seangoozey/vnoctis-vnm-api:latest`,
`ghcr.io/seangoozey/vnoctis-vnm-builder:latest` and
`ghcr.io/seangoozey/vnoctis-vnm-ui:latest`. `.env` image overrides can select a
different tag or registry. GHCR packages must be public for anonymous pulls, or
your Docker client must authenticate with access to them.

Open **http://localhost:6773** (or your configured `HOST_PORT`) and sign in using
the initial admin credentials from `.env`.

### Existing installations

Read [fork development and migration](docs/fork-development.md#existing-server-transition)
before changing branches, images or Compose files. Preserve the current database,
keys, game directory names and mounts. Existing TrueNAS overrides still need both
`-f compose.yml -f compose.save-sync.yml` until their settings are migrated.

`compose_local_build.yml` is the older standalone named-volume layout. Switching
to it, or away from it, does not migrate data automatically. Keep using your
existing Compose invocation until the storage layout has been compared.

---

## ⚙️ Configuration

Copy [`.env.example`](.env.example) to `.env` for settings forwarded by Compose. Advanced service environment variables that are not referenced in `compose.yml` need a local Compose override. After changing container environment values, **recreate** the affected service using your existing Compose files; `restart` does not apply new `.env` values.

### Paths

Set **`VNM_ROOT`** to a single root directory and all sub-paths are derived automatically. This is the only path variable you need.

| Variable | Default | Description |
|---|---|---|
| `VNM_ROOT` | `/mnt/user/appdata/vnm` | Root directory for all VNoctis Manager data. The following sub-directories are used under this path: |

```
${VNM_ROOT}/
├── games/          # Ren'Py visual novel game directories
├── renpy-sdk/      # Ren'Py SDK (auto-downloaded on first start)
├── data/           # SQLite database, keys, logs and job/backup staging
│   ├── logs/       # vnm-api.log + vnm-builder.log
│   ├── import-jobs/ # Staged uploads for background imports
│   └── save-backups/ # Temporary backup/import tasks (24-hour expiry)
├── covers/         # Cached cover art images
├── screenshots/    # Cached VNDB screenshot images
└── web-builds/     # Compiled output, retained job logs and builder queue records
```

### Networking

| Variable | Default | Description |
|---|---|---|
| `HOST_PORT` | `6773` | Port exposed on the host for the web UI |

### Images

| Variable | Default | Description |
|---|---|---|
| `VNM_API_IMAGE` | `ghcr.io/seangoozey/vnoctis-vnm-api:latest` | Optional override for the API image used by `compose.yml` |
| `VNM_BUILDER_IMAGE` | `ghcr.io/seangoozey/vnoctis-vnm-builder:latest` | Optional override for the builder image used by `compose.yml` |
| `VNM_UI_IMAGE` | `ghcr.io/seangoozey/vnoctis-vnm-ui:latest` | Optional override for the UI image used by `compose.yml` |

### Authentication

| Variable | Default | Description |
|---|---|---|
| `VNM_ADMIN_USER` | `admin` | Initial admin username — used to seed the admin account on **first startup only**; subsequent logins authenticate against the database |
| `VNM_ADMIN_PASSWORD` | *(required)* | Initial admin password — used to seed the admin account on **first startup only** (stored as a bcrypt hash in the database); also used when `RESET_ADMIN_PASSWORD=true` to force-reset the admin password |
| `VNM_JWT_SECRET` | *(auto-generated)* | JWT signing secret; auto-created and persisted to `/data/.jwt-secret` if not provided |
| `VNM_SESSION_TTL_DAYS` | `30` | How many days login sessions remain valid before requiring re-authentication |
| `RESET_ADMIN_PASSWORD` | `false` | Set to `true` to force-reset the initial admin account's password from `VNM_ADMIN_PASSWORD` on next startup; remove the override after recovery; this is not automatically cleared |

`RESET_ADMIN_PASSWORD` is supported by the API but is not forwarded by the base
Compose file. For recovery, set the desired `VNM_ADMIN_PASSWORD` in `.env` and
append a temporary local override to your **existing** Compose invocation:

```yaml
# compose.admin-reset.yml
services:
  vnm-api:
    environment:
      RESET_ADMIN_PASSWORD: "true"
```

Recreate `vnm-api` with that override, verify the password, then recreate it using
the normal invocation without the reset override. Keep any source-build and
permission/resource overrides in both invocations.

### VNDB Integration

| Variable | Default | Description |
|---|---|---|
| `VNDB_API_BASE` | `https://api.vndb.org/kana` | VNDB API base URL |
| `VNDB_RATE_DELAY_MS` | `200` | Delay between VNDB API requests (ms) |
| `VNDB_MATCH_THRESHOLD` | `0.7` | Fuzzy match confidence threshold (0.0–1.0) |
| `VNDB_API_TOKEN` | *(empty)* | Optional VNDB API token for higher rate limits ([get one here](https://vndb.org/u/tokens)) |
| `METADATA_TTL_DAYS` | `30` | Days before metadata is considered stale and re-fetched |

### Builder

| Variable | Default | Description |
|---|---|---|
| `BUILD_CONCURRENCY` | `1` | Maximum concurrent Ren'Py web builds |
| `RENPY_SDK_VERSION` | `8.5.2` | Ren'Py SDK version — the builder auto-downloads the SDK + web platform on first start if they are not present in `RENPY_SDK_PATH` |

### Image Compression (Web Builds)

| Variable | Default | Description |
|---|---|---|
| `COMPRESS_JPEG_QUALITY` | `80` | JPEG quality target (0–100). Lower = smaller files, more artifacts |
| `COMPRESS_PNG_QUALITY` | `60-80` | PNG quality range for pngquant lossy palette quantisation (min-max, 0–100) |
| `COMPRESS_WEBP_QUALITY` | `80` | WebP quality target (0–100) |
| `COMPRESS_WEBP_METHOD` | `2` | WebP encoder effort (0–6), independent of quality; `4` restores the earlier method |
| `COMPRESS_WORKERS` | `0` | `0` = auto within the container CPU quota/affinity. Positive values request fewer workers; concurrent builds share the allowance |

### Cloudflare R2 Publishing

| Variable | Default | Description |
|---|---|---|
| `VNM_R2_MODE` | `false` | Set to `true` to enable Cloudflare R2 publishing mode. On first start in R2 mode, `vnm.db` is copied to `vnm-r2.db` (the base database is never modified). All R2 tables and columns are applied to `vnm-r2.db` only. R2 credentials are configured at runtime via the admin UI (R2 settings modal in the navigation bar). |

> **Note:** R2 credentials (account ID, access key ID, secret, bucket name, public URL) are stored in the database at runtime via the admin settings page — they are **not** environment variables. The secret access key is encrypted at rest using AES-256-GCM.

The builder's default Compose limits are 8 CPUs and 16 GiB memory. Adjust those
in a local override for your host. Compression respects the container's actual
quota/affinity rather than using every host CPU; `BUILD_CONCURRENCY` and
`COMPRESS_WORKERS` control different levels of parallelism.

### General

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |
| `LOG_PATH` | `/data/logs` | Directory for persistent log files inside the container. Both vnm-api and vnm-builder write structured JSON logs here (`vnm-api.log` and `vnm-builder.log`). Logs are also written to stdout for `docker compose logs`. |
| `TZ` | `America/Chicago` | Container timezone |
| `PUID` | `99` | API user ID for bind-mount ownership; the default builder is explicitly configured as root |
| `PGID` | `100` | API group ID for bind-mount ownership |

---

## ☁️ Cloudflare R2 Publishing

VNoctis Manager can publish built web games to [Cloudflare R2](https://developers.cloudflare.com/r2/) — Cloudflare's S3-compatible object storage — making games publicly accessible without needing to serve them from the manager itself. A self-contained static gallery page (`index.html`) is automatically regenerated whenever games are published or unpublished.

### Setup

1. **Enable R2 mode** — add `VNM_R2_MODE=true` to your `.env` and recreate the API container using your normal Compose files. On first start, `vnm.db` is copied to `vnm-r2.db`; the original database is never modified.

2. **Create a Cloudflare R2 bucket** in the Cloudflare dashboard with public access enabled (set a custom domain or use the bucket's `r2.dev` subdomain).

3. **Create an R2 API token** with _Object Read & Write_ permissions scoped to your bucket.

4. **Configure credentials in VNoctis Manager** — log in as admin, click the **R2** button in the navigation bar (only visible in R2 mode) to open the settings modal, and fill in:
   - **Account ID** — from the Cloudflare dashboard
   - **Access Key ID** — from the R2 API token
   - **Secret Access Key** — from the R2 API token (encrypted at rest with AES-256-GCM)
   - **Bucket Name** — the R2 bucket name
   - **Public URL** — the base URL for your bucket (e.g., `https://vn.example.com`)

5. **Test the connection** — click **Test Connection** to verify credentials and bucket access before saving.

### Publishing a Game

Once credentials are saved, any fully-built game can be published:

- **From the Library** — open the game detail modal and click **Publish to R2** (cloud upload icon)
- **From the Gallery** — hover a game card and click the upload icon, or open the detail modal

A progress modal streams real-time upload progress. On completion, a **View Published** link opens the public gallery in a new tab.

### What Gets Uploaded

For each game, VNoctis Manager uploads the entire web build to `{bucket}/{gameId}/`:

```
{bucket}/
├── {gameId}/          # Web build files
│   ├── index.html
│   ├── game.data
│   ├── game.js
│   ├── game.wasm
│   └── ...
├── gallery.json       # Gallery metadata (auto-regenerated)
└── index.html         # Static gallery page (auto-regenerated)
```

The **static gallery** (`index.html`) is a self-contained single-file page with embedded CSS and vanilla JS. It supports searching, sorting, and opening a game detail modal with a **Play** button that launches the game in a full-screen iframe player with a top navigation bar. The player includes a **Library** button to return to the gallery — no browser back button needed.

### Publish Status

Games display their R2 publish status across the UI:

| Badge | Meaning |
|---|---|
| ✓ **R2** (green) | Published and accessible |
| ↑ **Uploading** (pulsing yellow) | Publish in progress |
| ○ **Unpublished** (gray) | Built but not published |

### Unpublishing

Open the game detail modal and click **Unpublish** — this deletes all game files from R2 under `{bucket}/{gameId}/` and regenerates the static gallery without the unpublished game.

### Scope

R2 publishes a public static gallery and game assets. Cross-origin published
games do not receive the manager's authenticated save synchronization or offline
preparation features. Those features target same-origin games served by VNoctis.

---

## 📤 Game Import (Upload Archive or URL)

You can import a Ren'Py game directly from the UI — either by uploading a local archive file or by pasting a remote URL.

**Supported archive formats:** `.zip`, `.tar.bz2`, `.rar`

### Method 1: Upload File

1. Click the green **Import Game** button in the top navigation bar.
2. Select the **Upload File** tab (default).
3. **Drag and drop** an archive file (`.zip`, `.tar.bz2`, or `.rar`) onto the drop zone, or click to browse.
4. Click **Upload & Import**. VNoctis creates a job and uploads bounded chunks through a small pipeline, verifying chunks alongside transfer without a full-file pre-scan. Progress distinguishes bytes sent from bytes confirmed by the server.
5. Keep the browser open to transfer the file, or **Pause & close**. To resume, reopen **Import Game** (or **Jobs → Resume upload**) and reselect the same archive. Confirmed chunks survive browser reloads and API restarts and are retained for 24 hours after the last confirmed progress.
6. Once the complete verified upload is accepted, archive inspection, extraction and registration continue in the background. Follow the job from **Jobs**; the game appears in the library after processing completes.

Unfinished uploads belong to the administrator who started them. Automatic retries
are bounded, and failures include an upload ID and downloadable diagnostics without
authentication tokens. If all bytes arrived but final acceptance was interrupted,
**Jobs → Finish upload** queues processing without selecting the file again.
See [resumable imports](docs/resumable-imports.md) for recovery and deployment details.

### Method 2: From URL

1. Click the green **Import Game** button in the top navigation bar.
2. Select the **From URL** tab.
3. Paste a direct download URL to an archive file (e.g., `https://example.com/game.zip`).
4. Click **Download & Import** — the API immediately accepts a background job and returns its ID.
5. Follow download, extraction and registration from **Jobs**. Processing continues after closing the overlay or browser.

> URL downloads happen server-side. Jobs show byte progress when the remote server supplies a size, plus the current stage and retained log. URL imports infer the archive format from the URL filename; unrecognised extensions default to `.zip`. Failed/cancelled processing can be retried from Jobs while its staged input remains available. See [background jobs](docs/background-jobs.md) for restart and cleanup behavior.

### Archive Structure Handling

The import handles two common archive layouts:

| Archive Structure | Behavior |
|---|---|
| `GameName.zip` → contains a single folder `GameNameFolder/` | Extracts to `/games/GameNameFolder/` (uses the inner folder name) |
| `GameName.zip` → contains `game/`, `game.sh`, `game.exe` at root | Creates `/games/GameName/` from the archive filename and extracts into it |

> The same logic applies to `.tar.bz2` and `.rar` archives.

### Reverse Proxy Configuration

If you use a **reverse proxy** in front of VNoctis Manager (e.g., **Nginx Proxy Manager**, Traefik, Caddy), configure its limits for the operations you use. The browser importer sends at most 16 MiB per request and can reduce chunks after HTTP 413 responses; the default total game-archive limit remains 24 GiB. Legacy multipart uploads and save-backup imports still need their larger request limits:

#### Nginx Proxy Manager

Edit the proxy host for VNoctis Manager → **Advanced** tab → paste:

```nginx
client_max_body_size 24576m;
proxy_connect_timeout 300;
proxy_send_timeout 600;
proxy_read_timeout 600;
```

#### Standard Nginx / OpenResty

Add to the `server` or `location` block:

```nginx
client_max_body_size 24576m;
proxy_connect_timeout 300;
proxy_send_timeout 600;
proxy_read_timeout 600;
```

#### Traefik

```yaml
# Dynamic configuration (file provider)
http:
  middlewares:
    vnoctis-upload:
      buffering:
        maxRequestBodyBytes: 25769803776  # 24 GiB
```

Attach that middleware to the VNoctis router using the appropriate provider
reference. Traefik buffers requests before forwarding them, including to disk;
allow enough proxy storage for large uploads. See the [buffering documentation](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/buffering/).

#### Caddy

```caddyfile
request_body {
    max_size 25769803776 # 24 GiB
}
```

See Caddy's [`request_body` reference](https://caddyserver.com/docs/caddyfile/directives/request_body) for the versions and syntax supported by your installation.

The bundled Nginx permits 24 GiB requests for legacy game uploads. New browser imports use chunks of at most 16 MiB, reducing after HTTP 413 responses down to 256 KiB. Save-backup ZIPs have a separate 16 GiB limit. Proxy body limits and idle timeouts still apply to each request; extraction/build time does not need one HTTP request to stay open.

---

## 📦 Pre-built ZIP Import

If you have already built a game's web distribution on another machine (or don't want to use the built-in builder), you can import the pre-built output directly:

### Method 1: Automatic (ZIP in game directory)

1. **Build the game** on another machine using Ren'Py's "Build Distributions → Web" option.
2. **Place the resulting `.zip` file** into the game's directory on the host:
   ```
   /your/games/path/MyVisualNovel/
   ├── game/
   │   ├── script.rpy
   │   └── ...
   └── MyVisualNovel-web.zip    ← drop the ZIP here
   ```
3. **Trigger a scan** — the scanner runs automatically on container startup, or you can trigger one manually via `POST /api/v1/library/scan`.
4. **Automatic extraction** — the scanner detects the ZIP, extracts it to `/web-builds/<game-directory-name>/`, verifies that `index.html` exists in the output, and marks the game as built.
5. **Play immediately** — the UI will show **▶ Play** instead of **▶ Build & Play**, and the game is ready to play in the browser.

> **Tip:** This is useful for games that require specific Ren'Py SDK versions or custom build configurations that differ from the builder's environment.

### Method 2: Manual Extraction + Mark as Playable

If the automatic ZIP import fails (e.g., very large archives, nested ZIP structures, or non-standard layouts), you can manually extract the web build and tell VNoctis Manager it's ready:

1. **Extract the web build** directly into the web-builds volume on the host:
   ```
   /your/web-builds/path/MyVisualNovel/
   ├── index.html              ← must exist at this level
   ├── game.data
   ├── game.js
   ├── game.wasm
   └── ...
   ```
   > The folder name must match the game's directory name in `/games/`.

2. **Open the game** in the UI — click the game card, then click **Play** (or navigate to `/play/<gameId>`).
3. **Click "Mark as Playable"** — the button appears below "Build Now" on the build screen. The system verifies that `index.html` exists in the expected `/web-builds/<folder>/` location and marks the game as built.
4. **Play immediately** — the game loads in the in-browser player.

> If the web build files aren't in the right location, the button shows an error message indicating the expected path.

---

## 🩹 Patches and Mods

Administrators can open **Patches** in the game launcher before or after its first
build. Upload a loose `.rpy` file or a ZIP containing scripts and assets, review
the destination folder, replacements, instructions and exclusions, then install.
Wrapped `game/` folders are detected; ambiguous layouts require a folder choice.
Paired source/compiled scripts use the source and are recompiled by the SDK.
Compiled-only patches remain dependent on their original engine version.

Enable, disable, reorder or remove installed packages from the same window.
Later enabled patches take precedence. Changes require a build/rebuild and are
locked while a build is queued or running. Patches are applied in temporary build
overlays before compression; original game files stay untouched and an existing
playable build remains available until replacement succeeds.

Uploads are limited to 256 MiB, with 512 MiB extracted and 10,000 archive entries.
Only `.rpy` and ZIP uploads are supported; installers, nested archives, engine
replacements and patches requiring file deletions need manual handling. Inspection
checks paths, collisions, integrity and limits, but cannot establish game/version
compatibility. Test the rebuilt game before relying on it.

Patch metadata lives in the application database and package files in
`${VNM_ROOT}/web-builds/.vnm-patches/`, which Nginx blocks from public access. Include
both in a full application backup; save backup ZIPs do not include patches.
Removing a patch removes its package files after the configuration update;
unfinished previews are cleaned on later uploads after 24 hours. Failed build
retries capture the current patch configuration.

---

## 🗜️ Image Compression (Web Builds)

When building a web distribution, the builder can compress images to reduce the final download size served to browsers. A **"Build Options"** dialog appears when you click Build or Rebuild, letting you choose whether to compress assets for each build.

### How It Works

The builder runs SDK work in a temporary overlay. SDK-writable `.rpy`, `.rpyc`,
`.rpym` and `.rpymc` scripts and progressive-download rules are copied locally;
other unchanged assets can be symlinked. Packed assets are extracted into
preparation storage when required. Original imported files are retained.

| Format | Tool | Processing |
|---|---|---|
| JPEG | `jpegoptim` | Lossy re-quantisation and metadata stripping |
| PNG | `pngquant` | Palette quantisation with transparency support |
| WebP | Pillow | Re-encoding at the configured quality and encoder method |
| BMP | Pillow | Conversion to PNG |

Savings and build times depend on source images, hardware and settings. The
quality values in the [compression configuration](#image-compression-web-builds)
are passed to the builder; WebP encoder effort is a separate setting.

### Rebuilds and asset reuse

- With no reusable compression record, **Compress assets** is checked by default.
  Uncheck it for an uncompressed build.
- With reusable optimized images, the dialog shows their count and an unchecked
  **Force recompress assets** option. Leave it unchecked to reuse unchanged
  published images; new/changed images are optimized as needed.
- Checking **Force recompress assets** starts from the original source images.
  Changed settings/tool versions or missing/damaged output also require fresh
  optimization. Older builds need one tracked optimization build to gain reuse.

Reuse checks source/output hashes and settings, using the actual published files
or `game.zip` members. There is no extra permanent cache containing a second full
game. Temporary overlays are removed afterward. The log's “N% of original” is a running output/input size ratio. Its separate
image-count percentage covers compression only, not overall build progress.

Compression failures can fall back to an uncompressed overlay. A failed rebuild
retains the previously validated playable output. See [build recovery and
compression](docs/background-jobs.md) for details.

---

## 📥 Progressive Downloads (Web Builds)

When building for the web, the builder automatically generates a `progressive_download.txt` file in the game's project root before invoking `web_build`. This file tells Ren'Py which assets to stream on demand versus which to bundle into the initial `game.data` payload.

### Default Rules

```text
# RenPyWeb progressive download rules - first match applies
# '+' = progressive download, '-' = keep in game.data (default)
#
# +/- type path
- image game/gui/**
+ image game/**
+ music game/audio/**
+ music game/music/**
+ voice game/voice/**
```

| Rule | Effect |
|------|--------|
| `- image game/gui/**` | GUI images (menus, buttons, overlays) are bundled in `game.data` and available immediately on load |
| `+ image game/**` | All other images (backgrounds, sprites) stream on demand — displayed as pixellated placeholders until loaded |
| `+ music game/audio/**` | Music in `game/audio/` streams on demand — replaced by silence until loaded |
| `+ music game/music/**` | Music in `game/music/` streams on demand |
| `+ voice game/voice/**` | Voice lines stream on demand — replaced by silence until loaded |

First-match applies, so `game/gui/**` is excluded before the broader `game/**` catch-all.

### Preserving Custom Rules

If a `progressive_download.txt` file already exists in the game's project root (e.g. shipped with the original game, or manually placed), the builder **does not overwrite it**. The build log will show:

```
[vnm-builder] progressive_download.txt already exists — keeping existing rules
```

This applies to all build paths: compressed, uncompressed, and rebuilds. The file is copied into the temporary build overlay (if it existed) or generated there — original game files are never modified.

---

## 💾 Saves, Backups and Offline Play

### Save synchronization and history

Same-origin games synchronize saves by authenticated account and stable game ID.
Saves survive rebuilds and library removal; missing games' saves remain retained
until explicitly deleted. Administrators manage those records from **Orphaned
saves**. Deleting a user deletes that user's saves and history.

Open **Save History** from either launcher to inspect retained versions, restore
progress, delete non-current versions, import native save folders/files, or
export/import a **VNoctis backup ZIP**. Keep backup ZIPs intact for reimport;
VNoctis preserves save bytes; it does not translate saves between Ren'Py
engine versions. Desktop compatibility depends on the game and engine versions. History is separate from Ren'Py's rotating
save slots. Native folder import works before first play when a build has known
save-directory metadata; otherwise run the game once for runtime detection.

Startup waits for save preparation before releasing the engine. Supported builds
load the newest slot and metadata first, then prefetch other slots; loading an
uncached slot waits for that file. Pending offline progress and older builds can
require fuller hydration. The current loading screen can remain at **Downloading
game data… 100%** during this preparation; the toast's dismissal timer does not
control the wait. Detailed sync/recovery limits are in [save synchronization](docs/save-sync.md).

### Personal and administrator backups

Open **Dashboard → Save backups** to export/import your account across games.
Administrators can choose **All users** and review destination account/game
mappings. Existing current progress is kept by default; explicit replacement
preserves the previous version in history. Missing users are recreated as viewers
and need passwords set by an administrator. Missing games retain saves and match
later installations using the same game-directory identity; renamed games need
explicit mapping.

Backups include synced current saves, retained history and required signing data,
with duplicate binary files stored once. They exclude unsynced browser-only
progress, account passwords/roles, settings and game/build files. A save backup
is therefore **not a full application backup**. Preserve deployment data and keys
separately for full migration/rollback. Temporary backup tasks expire after 24
hours; completed imports remain saved. The ZIP limit is 16 GiB and each snapshot
is limited to 128 MiB. See [portable backups](docs/save-sync.md#portable-save-backups).

### Cached downloads versus prepared offline games

Normal launches reuse downloaded game assets where possible. That alone does not
prepare the whole game for offline use. On **Dashboard**, choose **Prepare a game
for offline play** to download and verify the app shell, game assets and your
save checkpoint. Existing builds need rebuilding once to acquire an asset
inventory and the supported save adapter. The dashboard reports readiness and
supports checking, updating and removing downloads.

Save data and offline readiness belong to the signed-in account; public game
asset bytes can be reused across accounts. **Protect downloaded files** requests
browser storage persistence, but the browser can deny it. Quotas, eviction,
clearing site data, changed browser origins and rebuilds can affect readiness.
Check the dashboard before disconnecting. Removing downloaded game assets does
not erase saves or pending uploads. See [game download storage](docs/game-download-storage.md)
and [offline readiness](docs/save-sync.md) for limitations.

---

## 📡 API Reference

All endpoints are prefixed with `/api/v1` and proxied through Nginx. The tables
summarize the primary routes; request schemas, save limits and recovery protocols
are documented in the linked feature guides and route implementations.

### Authentication & Users

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/login` | — | Authenticate with username/password; returns `{ token }`, containing a JWT with user ID, username and role claims |
| `POST` | `/auth/logout` | — | End session (client removes token) |
| `GET` | `/auth/me` | any | Validate current session, returns `{ userId, username, role }` |
| `GET` | `/users` | admin | List all users with favorite counts |
| `POST` | `/users` | admin | Create a new user (`{ username, password, role? }`) |
| `PATCH` | `/users/:userId` | admin | Update a user's role (`{ role }`) |
| `DELETE` | `/users/:userId` | admin | Delete a user and their favorites/saves/history; cannot delete self or last admin |
| `POST` | `/users/:userId/reset-password` | admin | Reset a user's password (`{ password }`) |

### Favorites

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/favorites` | any | List current user's favorited game IDs |
| `POST` | `/favorites/:gameId` | any | Add a game to the current user's favorites |
| `DELETE` | `/favorites/:gameId` | any | Remove a game from the current user's favorites |

### Library

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/library` | any | List all games with per-user `favorite` field (supports `search`, `sort`, `order`, `buildStatus`, `metadataSource`, `includeHidden` query params — hidden games filtered out by default; pass `includeHidden=true` to include them) |
| `GET` | `/library/:gameId` | any | Get full detail for a single game (includes per-user `favorite` field) |
| `POST` | `/library/scan` | admin | Trigger a full directory rescan (returns `202` with job ID) |
| `GET` | `/library/scan/:jobId` | any | Get scan job status |
| `PATCH` | `/library/:gameId` | admin | Update game metadata (manual overrides); also accepts `hidden` (Boolean) to hide/unhide a game |
| `POST` | `/library/:gameId/mark-playable` | admin | Manually mark a game as playable (verifies `index.html` exists in `/web-builds/<dir>/`) |
| `POST` | `/library/unhide-all` | admin | Bulk unhide all hidden games; returns `{ unhiddenCount }` |
| `DELETE` | `/library/:gameId` | admin | Delete game source, output, covers/screenshots and library entry; saves and durable job/log records remain independently managed |
| `POST` | `/library/import` | admin | Upload `.zip`, `.tar.bz2` or `.rar` (multipart field `file`); returns `202` and `{ jobId, status }` after staging the complete upload |
| `GET` | `/library/import-uploads/limits` | admin | Total archive limit, chunk size and retention |
| `GET`, `POST` | `/library/import-uploads` | admin | List own unfinished uploads; create an idempotent upload/job with `{ uploadId, name, size, protocol: 2 }` |
| `GET`, `DELETE` | `/library/import-uploads/:id` | owning admin | Read confirmed offset/pending verified ranges or discard an unfinished upload |
| `PUT` | `/library/import-uploads/:id/chunk?offset=N` | owning admin | Raw chunk with `X-Chunk-SHA256`; acknowledge durable confirmed offset |
| `POST` | `/library/import-uploads/:id/complete` | owning admin | Idempotently queue a complete verified archive for import |
| `POST` | `/library/import-url` | admin | Accept a URL-import job (JSON `{ "url": "..." }`); returns `202` and `{ jobId, status }`, progress via Jobs |

### Metadata & Builds

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/covers/:gameId` | — | Serve cached cover image for a game |
| `GET` | `/metadata/vndb/search?q=` | admin | Search VNDB by title (min 3 chars) — returns `[{ id, title, alttitle, developer, released }]` for autocomplete |
| `GET` | `/metadata/steam/search?q=` | admin | Search Steam metadata |
| `GET` | `/library/:gameId/compression` | any | Inspect published compression/reuse metadata |
| `POST` | `/metadata/:gameId/refresh` | admin | Re-fetch VNDB metadata (optional body: `{ "vndbId": "v12345" }` to force-link) |
| `POST` | `/build/:gameId` | admin | Accept a background build (`compressAssets`, `forceRecompress`); returns `202` and a job ID |
| `GET` | `/build/:jobId` | any | Get build job status |
| `GET` | `/build/:jobId/log` | admin | Legacy authenticated SSE build-log stream; current UI uses `/jobs/:id/log` |
| `DELETE` | `/build/:jobId` | admin | Cancel a queued or in-progress build |
| `GET` | `/health` | — | Service health check (database, builder, library stats) |

### Patches (admin)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/games/:gameId/patches` | Installed packages, order, revision and rebuild state |
| POST | `/games/:gameId/patches/preview` | Upload and inspect a `.rpy` or ZIP package |
| POST | `/games/:gameId/patches/:packageId/preview` | Preview a selected package folder |
| POST | `/games/:gameId/patches` | Confirm installation at the reviewed revision |
| PUT | `/games/:gameId/patches` | Confirm complete package order and enabled state |
| DELETE | `/games/:gameId/patches/:packageId` | Discard a draft, or remove an installed package using `?revision=` |

### Background Jobs (admin)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/jobs` | Paginated retained import/build jobs; `active=1` filters active work |
| `GET` | `/jobs/:id` | Durable status, stage, timestamps and errors |
| `GET` | `/jobs/:id/log` | Cursor-based log reads (`offset`); `download=1` streams the full log |
| `POST` | `/jobs/:id/cancel` | Cancel before final publication/registration |
| `POST` | `/jobs/:id/retry` | Retry failed/cancelled work when required inputs remain available |
| `DELETE` | `/jobs/:id` | Remove terminal job/log records and unneeded staging; keep the game/build |

The viewer retains the latest 5,000 nonempty lines; full downloads contain the
complete log. Closing a launcher does not delete logs. See [background jobs](docs/background-jobs.md).

### Save Sync, History and Storage

These routes require authentication and operate on the signed-in account, except
for the explicitly public build identity and administrator orphan controls.

| Method | Endpoint | Description |
|---|---|---|
| `GET`, `PUT` | `/games/:gameId/saves` | Read current progress/manifest; upload revision-checked changes |
| `POST` | `/games/:gameId/saves/directory` | Record the game's runtime save destination |
| `GET` | `/games/:gameId/saves/files/:hash` | Read an owned current binary save/support file |
| `GET` | `/games/:gameId/saves/files/:hash/preview` | Read a native save's metadata/thumbnail |
| `GET` | `/games/:gameId/saves/versions/:versionId/files/:hash` | Read a file pinned to an owned historical version |
| `GET` | `/games/:gameId/saves/history` | Paginated history and destination metadata |
| `GET` | `/games/:gameId/saves/history/:versionId` | Read a historical snapshot as API data |
| `POST` | `/games/:gameId/saves/history/import` | Import selected native files with revision checks |
| `POST` | `/games/:gameId/saves/history/:versionId/restore` | Restore a version while preserving previous progress |
| `DELETE` | `/games/:gameId/saves/history/:versionId` | Delete a non-current version |
| `GET` | `/games/:gameId/cache-build` | Public build identity only; no private saves |
| `GET` | `/games/:gameId/offline-manifest` | Authenticated build inventory for offline preparation |
| `GET` | `/games/:gameId/offline-file` | Authenticated original asset, pinned to inventory/build |
| `GET` | `/admin/orphaned-saves` | Admin: list saves for games outside the library |
| `GET`, `DELETE` | `/admin/orphaned-saves/:userId/:gameId` | Admin: export or explicitly remove orphaned saves/history |

See [save sync](docs/save-sync.md) and [asset storage](docs/game-download-storage.md).

### Portable Save Backups

Task routes belong to the authenticated owner. Exporting/restoring all users
also requires the current administrator role.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/save-backups/exports` | Prepare a snapshot, personal or all-user backup ZIP |
| `POST` | `/save-backups/imports` | Stage one ZIP (multipart field `backup`), then verify it in the background |
| `GET` | `/save-backups/jobs` | List the current account's retained backup tasks |
| `GET` | `/save-backups/jobs/:id` | Read progress, review readiness or results |
| `GET` | `/save-backups/jobs/:id/contents` | Read source identities and available destinations |
| `POST` | `/save-backups/jobs/:id/preview` | Review account/game mappings without importing |
| `POST` | `/save-backups/jobs/:id/apply` | Apply the reviewed plan in the background |
| `POST` | `/save-backups/jobs/:id/download` | Obtain a short-lived, one-use native-download URL |
| `GET` | `/save-backups/download/:ticket` | Stream that prepared ZIP using its capability, without a JWT in the URL |
| `DELETE` | `/save-backups/jobs/:id` | Remove terminal/review task staging, keeping imported saves |

### R2 Settings *(R2 mode only — requires `VNM_R2_MODE=true`)*

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/settings/r2` | admin | Get current R2 configuration (secret masked as `••••••••••••••••`) |
| `PUT` | `/settings/r2` | admin | Save R2 configuration (`{ accountId, accessKeyId, secretAccessKey, bucketName, publicUrl }`); send the mask sentinel to preserve the stored secret |
| `POST` | `/settings/r2/test` | admin | Test R2 connection with stored or provided credentials; returns `{ ok, message }` |

### Publishing *(R2 mode only — requires `VNM_R2_MODE=true`)*

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/publish/:gameId` | admin | Start a publish job — uploads web build files to R2 and regenerates the static gallery; returns `202` with `{ jobId }` |
| `GET` | `/publish/:jobId` | admin | Get publish job status (DB record merged with live in-memory progress) |
| `GET` | `/publish/:jobId/progress` | — | SSE stream of publish progress events (`progress`, `snapshot`, `done`, `error`); public progress stream keyed by job ID |
| `DELETE` | `/publish/:gameId` | admin | Unpublish a game — deletes all R2 files under `{bucket}/{gameId}/` and regenerates the static gallery |
| `POST` | `/publish/gallery` | admin | Manually regenerate the static gallery on R2 without republishing any games |

### Internal (service-to-service)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/internal/client-error` | — | Report a client-side error for persistent logging (JSON body: `{ message, stack?, componentStack?, url?, userAgent? }`; rate-limited to 100/min) |
| `POST` | `/internal/build/:jobId/status` | — | Builder callback — update build job status (`building`, `done`, `failed`) |
| `POST` | `/internal/build/:jobId/log` | — | Builder callback — append a line to the retained job log |

> **Authentication:** Use `Authorization: Bearer <token>` from `POST /auth/login`. Jobs and build-log endpoints require admin access. Public exceptions include health, login/logout, cover images, build identity and the legacy publish-progress stream. Internal callbacks follow their service routes. `/auth/me` validates a token despite the global auth-prefix exemption. Save-backup downloads validate a short-lived, one-use capability. A game ID or job ID does not replace authentication on private routes.

---

## 🛠️ Development

Use the Docker stack for full player, Nginx and offline integration checks. To
run individual services natively, configure their environment explicitly, including
`VNM_ADMIN_PASSWORD` and isolated data paths; Compose normally supplies these
values. The commands below do not load the root `.env` automatically:

### vnm-api

```bash
cd services/vnm-api
npm ci
npx prisma generate
npm run dev
```

### vnm-ui

```bash
cd services/vnm-ui
npm ci
npm run dev
```

### vnm-builder

```bash
cd services/vnm-builder
pip install -r requirements.txt
cd src
python main.py
```

> **Note:** The Vite dev server is configured with a proxy in [`vite.config.js`](services/vnm-ui/vite.config.js) that forwards `/api` requests to `http://vnm-api:3001`. For local development, update the proxy target to `http://localhost:3001`.

---

### Validation and development scope

Use Node.js 24 and the locked dependencies. API tests need a generated Prisma
client; builder process-group/overlay checks require Linux. Browser integration
checks need Playwright's browser installed (or the supported installed-Chrome
option).

```bash
# From services/vnm-ui
npm test
npm run test:save-worker
npm run test:player

# From services/vnm-api (Prisma client generated)
npm test
python3 -m unittest discover -s test -p test_archives.py -v

# From services/vnm-builder, with requirements installed on Linux
python -m unittest discover -s tests -v
python -m unittest discover -s test -v
```

Native API startup uses container paths such as `/data` and `/games`; use an
isolated development environment rather than pointing tests at live deployment
data. For the main-based branch workflow, release preparation and server migration,
see [fork development](docs/fork-development.md).

---

## 📁 Project Structure

```text
├── .github/workflows/         # Container image publication
├── compose.yml               # Published-image stack; bind-mounted data
├── compose.build.yml         # Thin local source-build overlay; same data mounts
├── compose_local_build.yml   # Legacy standalone named-volume stack
├── .env.example              # Compose settings template
├── docs/                     # Fork migration, saves, storage and background jobs
├── services/
│   ├── vnm-api/
│   │   ├── prisma/           # Shared schema and database migrations
│   │   ├── src/routes/       # Library, Jobs, saves, backups, users, metadata, R2
│   │   ├── src/services/     # Durable jobs, archives, save storage and publishing
│   │   ├── templates/        # Static R2 gallery
│   │   └── test/             # API, migration, archive and storage checks
│   ├── vnm-builder/
│   │   ├── src/              # SDK builds, overlays, compression, save adapters
│   │   ├── tests/            # Compatibility, jobs, CPU limits and asset reuse
│   │   └── test/             # Save metadata/adapter and offline inventory checks
│   └── vnm-ui/
│       ├── public/           # Save bridge/workers and app/game offline workers
│       ├── src/components/   # Launchers, history/backups and shared controls
│       ├── src/hooks/        # Authentication, library and durable log access
│       ├── src/pages/        # Library, Dashboard, Player, Jobs, BuildLog, Users
│       ├── src/utils/        # Cache verification, offline state and save helpers
│       └── test/             # Unit and built-browser integration checks
├── tools/cache-test/         # Isolated asset-cache acceptance tools
├── extras/screenshots/       # Original interface screenshots
└── README_Security.md        # Historical security audit
```

The locally ignored `test-data/` contains development fixtures/tracking in the
maintainer checkout. It is not supplied by a clone and is not backed up by Git.

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | [React 19](https://react.dev/) · [Vite 6](https://vite.dev/) · [Tailwind CSS v4](https://tailwindcss.com/) |
| API Server | [Fastify 5](https://fastify.dev/) · [Node.js 24](https://nodejs.org/) |
| Build Worker | [FastAPI](https://fastapi.tiangolo.com/) · [Python 3.11](https://www.python.org/) |
| Database | [Prisma](https://www.prisma.io/) · [SQLite](https://www.sqlite.org/) |
| Reverse Proxy | [Nginx](https://nginx.org/) |
| Containerization | [Docker Compose](https://docs.docker.com/compose/) |

---

## 🔧 Troubleshooting

| Problem | Solution |
|---|---|
| **"No games found"** | Check `VNM_ROOT` in `.env`. Ensure each game directory inside `${VNM_ROOT}/games/` contains a `game/` subdirectory with `.rpy` files or a `renpy/` directory at the game root. |
| **"VNDB not matching"** | Try lowering `VNDB_MATCH_THRESHOLD` (e.g. `0.5`). You can also manually link a game via its VNDB ID in the detail modal, or use `POST /api/v1/metadata/:gameId/refresh` with `{ "vndbId": "v12345" }`. |
| **"Build failed"** | Verify the configured Ren'Py SDK (default 8.5.2) is installed and `${VNM_ROOT}/renpy-sdk` is writable by the builder. Open **Jobs → View log** for the retained full build log, or run `docker compose logs vnm-builder`. |
| **"Container unhealthy"** | Inspect logs with `docker compose logs <service>` for errors. Ensure volumes are correctly mounted and ports are not in use. |
| **Pre-built ZIP not detected** | Ensure the `.zip` is placed directly inside the game directory (alongside the `game/` folder). Trigger a manual rescan via the UI or API endpoint. |
| **"App won't start — missing VNM_ADMIN_PASSWORD"** | Set `VNM_ADMIN_PASSWORD` in your `.env` file. This variable is required and has no default value. |
| **"Session expired / logged out unexpectedly"** | Increase `VNM_SESSION_TTL_DAYS` in `.env` (default is 30 days). Clearing browser data also removes the session. |
| **"Forgot admin password"** | Use the temporary API environment override described under [Authentication](#authentication); set the desired password, recreate the API with the override, then recreate without it. The base file does not forward `RESET_ADMIN_PASSWORD` from `.env`. |
| **Finding error logs** | Persistent logs are at `${VNM_ROOT}/data/logs/vnm-api.log` and `${VNM_ROOT}/data/logs/vnm-builder.log` (structured JSON, one object per line). You can also use `docker compose logs vnm-api` / `docker compose logs vnm-builder` for recent stdout output. Client-side (browser) errors are forwarded to the API log via the `ErrorBoundary` component. |
| **R2 Settings button not visible** | The R2 button in the navbar only appears when `VNM_R2_MODE=true` and the user is an admin. Verify the env var is set in `.env` and the API was recreated with the updated environment using your normal Compose files. |
| **"R2 mode is not enabled" error in settings modal** | The modal shows this error when the `/settings/r2` endpoint returns `404`, which means the API started without `VNM_R2_MODE=true`. Check the container environment and recreate the API using the updated Compose configuration. |
| **R2 connection test fails** | Verify: (1) account ID matches the Cloudflare dashboard, (2) API token has _Object Read & Write_ permissions on the correct bucket, (3) bucket name is spelled correctly, (4) public URL starts with `https://`. |
| **Publish job stuck or failing** | Check `docker compose logs vnm-api` for upload errors. Common causes: R2 credentials not saved, bucket not found, or network timeout. Re-saving credentials and retrying usually resolves transient errors. |
| **Game download is at 100% but startup waits** | The engine also waits for save initialization. The current asset progress display does not show that phase; the save toast's timeout does not release the game. |
| **Game downloads repeat / offline preparation unavailable** | Use HTTPS or localhost, check Dashboard storage/readiness, and verify the browser supports service workers and has free storage. A rebuild changes cache identity. |
| **Save backup ZIP does not load in a desktop game** | It is a VNoctis reimport package, not a desktop save conversion. Use **Import backup ZIP** in Save History or Dashboard; native compatibility depends on engine versions. |
| **Logs disappear when closing a launcher** | Open **Jobs → View log** or `/build-log/<jobId>`. The durable log remains until its job record is explicitly removed. |
| **Published fork image cannot be pulled** | Verify the fork's Docker Images workflow completed and the GHCR package is public, or authenticate with package access. Use the source-build overlay until publication is ready. |
| **Static gallery not updating** | Use **Admin → R2 Settings → Regenerate Gallery** (or `POST /api/v1/publish/gallery`) to force a gallery rebuild. This uploads a fresh `index.html` and `gallery.json` without re-uploading any game files. |

---

## 🎭 Live2D Support

Some Ren'Py games use [Live2D Cubism](https://www.live2d.com/) for animated character models. Ren'Py's launcher GUI has a built-in "Install Live2D" button, but in a headless Docker environment you need to manually extract the SDK files into your Ren'Py SDK directory.

### What the GUI installer does

The launcher's "Install Live2D" buttons are simple zip extraction scripts that place platform-specific files into the SDK's `lib/` directories:

- **Native SDK** — Extracts `libLive2DCubismCore.so` (Linux x86_64) into `lib/py3-linux-x86_64/`
- **Web SDK** — Extracts `live2dcubismcore.js` into `lib/web/` (injected into the browser page via Emscripten at runtime)

### Manual installation

1. **Download** the [Cubism SDK for Native](https://www.live2d.com/sdk/download/native/) and [Cubism SDK for Web](https://www.live2d.com/sdk/download/web/) zip files.

2. **Place both zips** in the host SDK directory, `${VNM_ROOT}/renpy-sdk` for the default stack. It is mounted at `/renpy-sdk` inside the builder. Match the SDK versions expected by your Ren'Py release; see the [Ren'Py Live2D documentation](https://www.renpy.org/doc/html/live2d.html) and [installer source](https://github.com/renpy/renpy/blob/master/launcher/game/install.rpy).

3. **Extract the required files** using these commands inside the builder's shell (`docker compose exec vnm-builder sh`, using your normal Compose overrides). Alternatively, replace `/renpy-sdk` with its host path and run them on the host:

```bash
# --- Native SDK (libLive2DCubismCore.so for Linux) ---
unzip -j /renpy-sdk/CubismSdkForNative-*.zip \
  "*/Core/dll/linux/x86_64/libLive2DCubismCore.so" \
  -d /renpy-sdk/lib/py3-linux-x86_64/

# --- Web SDK (live2dcubismcore.js) ---
unzip -j /renpy-sdk/CubismSdkForWeb-*.zip \
  "*/Core/live2dcubismcore.js" \
  -d /renpy-sdk/lib/web/
```

The `-j` flag strips the internal directory structure so each file lands directly in the target directory.

4. **Verify** the files are in place:

```bash
ls /renpy-sdk/lib/py3-linux-x86_64/libLive2DCubismCore.so
ls /renpy-sdk/lib/web/live2dcubismcore.js
```

### Troubleshooting extraction

If the extractions fail, check the actual paths inside the zips first — internal directory structure can vary between SDK versions:

```bash
# Check Native zip structure
unzip -l /renpy-sdk/CubismSdkForNative-*.zip | grep -i "linux.*x86_64.*\.so"

# Check Web zip structure
unzip -l /renpy-sdk/CubismSdkForWeb-*.zip | grep -i "live2dcubismcore.js"
```

### After extraction

Rebuild the affected game after installing the libraries and verify its animations in the target browser. Supplying the libraries does not guarantee compatibility for custom Live2D wrappers or games built against a different engine/SDK version.

> **Tip:** If you rebuild your Docker containers frequently, consider adding these extraction commands to a setup script or placing the pre-extracted files directly in your mounted `RENPY_SDK_PATH` on the host so they persist across container recreations.

---

## 📄 License

The upstream README identifies VNoctis as MIT licensed, but this checkout currently has no `LICENSE` file. Recovering the license text from a verified upstream source is tracked in [fork development](docs/fork-development.md#overhaul-roadmap). Original attribution is retained.

---

## 🔒 Security

The [security audit](README_Security.md) is dated March 19, 2026 and predates the fork's Jobs, save sync, backups and offline work. Its findings are useful historical context, not a current audit of those additions or of your deployment.

---

## 🙏 Acknowledgments

- [starrlord/VNoctis](https://github.com/starrlord/VNoctis) — Original VNoctis Manager project
- [Ren'Py](https://www.renpy.org/) — Visual novel engine
- [VNDB](https://vndb.org/) — Visual novel database API
- Built with ❤️ for the visual novel community

