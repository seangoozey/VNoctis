# Ren'Py Web save synchronization

The authenticated `/play/:gameId` player synchronizes browser saves with VNoctis.
Saves are keyed by the authenticated user ID and stable database game ID, independent
of the web-build directory. Rebuilding or removing build output does not remove
server snapshots. Deleting a library Game or User deletes its snapshots by cascade.

## Persistence investigation

The deployment defaults to Ren'Py 8.5.2. Its official web package's `renpy-pre.js`
mounts Emscripten IDBFS at `/home/web_user/.renpy` and calls `FS.syncfs(true)`
under an `initFs` run dependency before Python starts. The compiled `renpy.js`
uses IndexedDB database version 21 with a `FILE_DATA` store; its default database
name is the mountpoint, shared by every game on that origin. LocalStorage is used
for web cache bookkeeping, not save bytes.

Numbered, quick, and auto slots are complete save files (including metadata,
screenshots, log and signatures). Persistent progress and preferences live in
`persistent`; token keys and upgrade metadata live in the mount's `tokens` folder.
Copying slots alone would miss persistent data and its verification keys.

Sources: [official 8.5.2 web package](https://www.renpy.org/dl/8.5.2/renpy-8.5.2-web.zip),
[save location](https://github.com/renpy/renpy/blob/8.5.2.26010301/renpy/savelocation.py),
[persistent data](https://github.com/renpy/renpy/blob/8.5.2.26010301/renpy/persistent.py),
[tokens](https://github.com/renpy/renpy/blob/8.5.2.26010301/renpy/savetoken.py).

## Integration

- `services/vnm-ui/src/pages/Player.jsx` loads the same-origin game iframe and
  displays bridge status. `useAuth.jsx` supplies the user; `useApi.js` describes
  the existing bearer-token convention.
- `services/vnm-ui/nginx.conf` serves `/web-builds/` from the shared volume and
  injects `/save-sync.js` at `<head>`, before Ren'Py scripts. This covers locally
  built exports, manually registered prebuilt builds, and scanned prebuilt web
  directories without editing their files.
- The bridge attaches an Emscripten `preInit` hook, redirects IDBFS's database
  name to `vnm-saves:<user>:<game>`, and wraps `FS.syncfs`. It leaves the filesystem
  paths expected by Python unchanged. Restoring finishes before the original
  populate callback releases the startup dependency.
- Backend routes follow the Fastify plugins and global JWT authentication in
  `services/vnm-api/src/index.js`. All authenticated users can access the shared
  library, including hidden games, as with the existing library detail route.
- Build paths are handled by `services/vnm-builder/src/builder.py`,
  `services/vnm-api/src/routes/import.js`, `routes/library.js`, and
  `services/scanner.js`; no build/import post-processing change is needed.

## API and storage

`GET /api/v1/games/:gameId/saves` returns `{ revision, snapshot }`; an absent
record has revision zero and a null snapshot. Responses are not cacheable.

`PUT /api/v1/games/:gameId/saves` accepts `{ revision, snapshot }` and returns
the incremented revision. A snapshot is `{ version: 1, files: [{ path, mtime,
data }] }`, where paths are relative to the mount, times are milliseconds, and
data is opaque base64. Directories are reconstructed. Empty directories are not
required for save validity. Deletions are represented by absence from the next
complete snapshot.

`SaveSyncState` stores a bounded JSON manifest and SHA-256 checksum in SQLite.
This uses the existing backup/migration path, and avoids DB/filesystem consistency
and orphan cleanup problems. Base64 costs roughly 33% extra storage and each
change uploads the full save tree; this is intentionally a bounded first version,
not a game-asset archive protocol. Limits are 32 MiB decoded bytes, 4096 files,
512-character relative paths, and a 46 MiB HTTP body. Files are never unpickled,
unzipped, or written to server filesystem paths.

Creation uses a unique `(userId, gameId)` key. Updates use an atomic conditional
revision update. Stale writers receive HTTP 409 and stop uploading; they cannot
silently replace the server. The server ignores body user IDs and derives identity
from the existing verified session. Parameter validation and a game existence
check precede save access.

## Migration, failures, and conflicts

An existing isolated local tree with no server record imports automatically.
Legacy IDBFS storage has no user/game ownership information, so it is never
silently assigned. On first use without either a server or isolated local copy,
the startup prompt lists legacy save directories. Select this game's directory
to copy it and token files, or continue without importing. The legacy database
stays untouched. On shared browsers, import only saves you own. Selecting the
wrong folder cannot be detected automatically.

Offline edits keep their last acknowledged server revision and a dirty flag.
Browser filesystem writes remain immediate. Server uploads are batched every
five seconds and retried on reconnect. Unchanged file contents and timestamp-only
touches do not upload or increment the server revision. Persistent-only changes
still synchronize even when no numbered save slot is created. The status remains
steady for fast uploads; “Syncing…” appears if a transfer takes over half a second.
The player notice disappears after four seconds and can be dismissed immediately.
Successful uploads containing newly written or changed Ren'Py `.save` slots
(numbered, quick, or auto saves) briefly show “Save synced,” including consecutive
saves with the same status text. Persistent-only updates, unchanged flushes, and
slot deletions do not bring it back. New offline/conflict/error
states briefly reveal it for eight seconds; recovery reveals it for four seconds.
Requests time out after eight
seconds; failure does not block gameplay or erase browser data. On reload, dirty
local data is retained if the server revision still matches. If it differs,
the startup prompt offers local play with sync paused or the server copy.
The latter first commits the browser tree to the `vnm-save-backups` IndexedDB
database (`snapshots` store, keys prefixed with the user/game namespace). These
backups are retained; there is no backup browsing UI in this first version.

Do not automatically retry a rejected upload with a newer revision: that would
turn conflict detection into an implicit last-writer-wins overwrite. Reload to
choose a copy. Login changes cannot make an old running game's bridge upload
its files using a new account's token.

## Compatibility and limits

The verified runtime is Ren'Py 8.5.2 with its standard HTML shell and IDBFS globals.
Compatible prebuilt ZIPs receive the same injection when served by VNoctis;
importing a prebuilt ZIP still uses existing import/scan/register behavior.
Custom HTML without a `<head>` tag, different runtime storage, a bridge blocked
by CSP, or cross-origin game hosting displays the player fallback status. Such
builds keep their original browser-local storage behavior and do not synchronize.
R2 public galleries are cross-origin and unauthenticated; they are outside this
feature. Direct game URLs without the player parameters also remain local-only.
The feature does not make the manager or game assets offline-installable.
If a game update changes its own `config.save_directory` or save compatibility,
the old snapshot remains stored, but VNoctis cannot make the new game interpret it.

Existing Ren'Py service workers match cached requests including their query
strings. Player URLs include user/game parameters, so they do not reuse older
unparameterized cached HTML. Avoid custom service workers that strip queries or
serve HTML from another build. Original third-party games already execute with
same-origin script access; storage namespaces are account isolation for normal
operation, not a sandbox against malicious game JavaScript.

## Validation

Run `npm test` in each service and `npm run build` in `services/vnm-ui`.
API tests apply all committed SQL migrations to a temporary SQLite database,
then verify authentication gating, user/game isolation, stale and concurrent
writers, traversal/payload limits, build-path changes, and cascading deletion.
Bridge tests exercise device handoff, offline save/reload/reconnect, competing
sessions, selected-folder legacy import, and declining import.

For the real-runtime browser check, unpack the official web SDK, set
`RENPY_WEB_RUNTIME` to its `web` directory, and run `npm run test:renpy` in the UI.
Install Playwright Chromium with `npx playwright install chromium`, or set
`CHROME_PATH` to an existing Chrome executable. This test uses the actual
Ren'Py HTML, JavaScript, WASM, filesystem, and IndexedDB in fresh browser contexts.
It suppresses Python/game startup because no game ZIP is needed; it verifies the
original `initFs` startup gate, byte-preserving handoff, and account/game isolation.

Before release, test a representative VN through its normal numbered, quick,
auto save/load UI, persistent preferences, and a compatible imported prebuilt
ZIP. Repeat the handoff between physical devices, including mobile Safari.
These full gameplay/device checks require game fixtures and are not covered by
the filesystem integration test.

## Separate upstream issue

The existing migration history lacks the Game `publishStatus`, `publishedAt`, and
`publishedVersion` columns present in the Prisma schema. Startup adds them only
in R2 mode. This predates save sync; the new migration intentionally does not
include an unrelated schema fix. The tests use the migrated baseline and id-only
game queries to verify save sync independently. Existing local deployment
permission overrides and Prisma repair steps should remain separate.
