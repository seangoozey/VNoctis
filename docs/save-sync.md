# Ren'Py Web save synchronization

The authenticated `/play/:gameId` player synchronizes browser saves with VNoctis.
Saves are keyed by the authenticated user ID and stable database game ID, independent
of the web-build directory. Rebuilding or removing build output does not remove
server snapshots. Removing a library Game retains its snapshots as orphaned saves;
rediscovering the same game ID makes them available again. Deleting a User still
deletes that account's snapshots by cascade.

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

`GET /api/v1/games/:gameId/saves` returns the live revision, snapshot, slot
checksum, and current history version ID. An absent record has revision zero and
a null snapshot. `?uploadId=...` also returns that upload's durable receipt.
Responses are not cacheable.

`PUT /api/v1/games/:gameId/saves` accepts `{ revision, snapshot, uploadId,
baseSaveChecksum, deviceLabel, alternate, branchId }`. It returns the accepted
revision, current server revision, history ID, and `current` or `alternate`
disposition. A snapshot is `{ version: 1, files: [{ path, mtime,
data }] }`, where paths are relative to the mount, times are milliseconds, and
data is opaque base64. Directories are reconstructed. Empty directories are not
required for save validity. Deletions are represented by absence from the next
complete snapshot.

`SaveSyncState` stores a bounded JSON manifest and SHA-256 checksum in SQLite.
This uses the existing SQLite backup/migration path. Each upload still sends the
full save tree. Limits are 32 MiB decoded bytes, 4096 files,
512-character relative paths, and a 46 MiB HTTP body. Files are never unpickled,
unzipped, or written to server filesystem paths.

Creation uses a unique `(userId, gameId)` key. Save transactions are serialized
for SQLite and store live state, immutable history, and receipts together. A stale
writer can advance live state only when the server's actual slots still match its
acknowledged baseline, or its incoming slots already match the server. Otherwise
its snapshot is preserved as an alternate without replacing live state. The
server ignores body user IDs and derives identity
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
Browser filesystem writes remain immediate. Written or atomically renamed
`.save` slots schedule a browser filesystem flush after the engine's synchronous
writes finish, without waiting for its periodic flush. They trigger a server
upload as soon as that flush succeeds. A slot written during an upload follows immediately after its
acknowledgement. Persistent-only writes are batched every five seconds, and
failed uploads are retried on that interval and on reconnect. Closing or killing
the tab during a transfer can still interrupt it; unacknowledged browser data
remains dirty for the next launch. Unchanged file contents and timestamp-only
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
local data is retained if the service cannot be reached. The browser records the
exact acknowledged `.save` bytes and server slot checksum in IndexedDB. On launch,
pending uploads are acknowledged or replayed first. Unsynced actual save progress
then uploads normally or is archived as an alternate if another device advanced.
The current server snapshot loads automatically afterward; there is no blocking
save-conflict choice. Unsynced seen-text/preferences alone do not create divergent
save progress. A running game can keep playing its alternate continuation and
back up subsequent slot changes; the next launch returns to synced saves.
Older `vnm-save-backups` databases are left untouched, but new recovery copies are
kept in server history instead.

Pending requests retain their upload ID, revision, and exact snapshot in the
`vnm-save-outbox` IndexedDB database. Retrying an acknowledged upload returns the
same accepted revision when its ID and checksum match its receipt, even if another
device advanced or that history version expired. Reusing an ID for different
bytes is rejected. On launch, a receipt also acknowledges a lost response. Offline save
writes remain local and retry after connectivity returns; the game itself still
needs its assets available to run offline.

`pageshow` and return to visible state restart exactly one retry timer and attempt
pending uploads. Hiding/leaving a page also attempts an upload, but browser
termination cannot guarantee delivery.

## Server save history

Both library and gallery game launchers have a **Save history** button. The list
belongs to the signed-in user and that game, including for administrators; admins
do not see other users' active-game history here. Versions show save type, device
label, time, logical snapshot size, and a Current badge. Download exports a JSON
snapshot. Restore is confirmed and creates a new live version, preserving the
exact prior live tree. It is used on the next game launch. A stale restore dialog
must refresh rather than overwrite an intervening save. Non-current versions can
be explicitly deleted.

History is outside Ren'Py's mounted filesystem. The engine's rotating ten
autosave slots and original filenames are unchanged. A historical restore
reconstructs exactly that version's original slots, persistent data, and tokens;
it never adds ninety autosave files to the live folder.

`SaveVersion` metadata and `SaveVersionFile` manifests refer to `SaveFileBlob`
rows keyed by SHA-256 of decoded file bytes. Identical content is shared even
across renamed/rotated slots. Uploads check existing blob hashes before inserting
bytes, so unchanged files are not passed back to the database. Retention scans
for unused blobs only when versions are removed, plus the periodic sweep.
Removing versions garbage-collects only blobs with
no remaining references. Each manifest is immutable; the live snapshot remains
separate. Existing synced data is archived lazily on first access/replacement.
History cannot recover saves overwritten before deployment.

Retention is applied on writes/history access and by hourly maintenance:

- Autosave/checkpoint versions from the past 24 hours: keep all.
- Older versions through seven days: keep the newest per hour containing saves.
- Older versions through thirty days: keep the newest per day containing saves.
- Manual/quick saves and explicit restores: keep their newest 40 independently.
- Current live version: always keep.
- Unresolved alternate continuations: keep until explicitly restored or deleted.

Hour/day buckets use UTC; the UI displays dates in the browser's local timezone.
Restoring an alternate resolves its continuation's earlier alternatives too;
those retained snapshots then follow their normal time/count policy. Actual slot
changes (including deletion) create history. Persistent-only writes keep syncing
but do not fill history. An initial checkpoint or pre-restore backup can capture
the complete current tree separately. Small upload receipts are retained until
the user or that game's orphaned saves are deleted, independently of history
expiry, so retries remain idempotent.

History captures snapshots received by the server. While offline, Ren'Py retains
its normal local rotating slots and the bridge retains pending/latest progress;
it does not archive every intermediate offline autosave. The latest offline
continuation is preserved when connectivity returns. Game assets must already
be available for offline play.

## Orphaned save administration

The admin navigation's **Saves** button opens an overlay styled like Import Game.
It lists orphaned snapshots by game title, owner, date, and stored size, with
download and individually confirmed deletion. Active games are excluded.
Each API operation verifies the current database admin role. A deletion checks
both the listed revision and continued absence of the game in one atomic SQL
statement, so a stale overlay cannot purge a returned game's saves. Lists are
paged at 50 entries; full payloads are fetched only for downloads.

Deleting orphaned saves also deletes that user's history and receipts for the
game, without removing shared content still referenced by another user/version.
Downloads are the current versioned JSON snapshot containing opaque save bytes and game
identity, not a native Ren'Py save ZIP. No reassignment/import UI or active-game
purge is included. The live snapshot has no automatic expiration; history follows
the retention policy above. Renaming a
game directory changes its fingerprint ID, so it does not automatically reclaim
the old directory's saves.

Do not bump revisions to force a divergent upload into live state: it must be
preserved as an alternate instead. Login changes cannot make an old running game's bridge upload
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
strings. Player URLs include user/game parameters and the SHA-256 version of the
bridge, so they do not reuse older game HTML after a bridge update. The UI image
injects the same version into the bridge script URL, and the manager entry HTML
requires cache revalidation to discover its latest hashed React assets.
Avoid custom service workers that strip queries or
serve HTML from another build. Original third-party games already execute with
same-origin script access; storage namespaces are account isolation for normal
operation, not a sandbox against malicious game JavaScript.

## Validation

Run `npm test` in each service and `npm run build` in `services/vnm-ui`.
Run `npm run test:player` in the UI for the built React player plus bridge test
in mobile-sized Chromium. It verifies that the startup toast disappears,
persistent-only uploads stay quiet, consecutive save acknowledgements become
visible, and notices can be dismissed. It also verifies the admin overlay and
library/gallery history download/restore controls, including mobile sizing and
nested modal dismissal. This uses a filesystem fixture, not a VN.
Set `CHROME_PATH` to an existing Chrome executable or install Playwright Chromium.
API tests apply all committed SQL migrations to a temporary SQLite database,
then verify authentication gating, user/game isolation, stale and concurrent
writers, traversal/payload limits, build-path changes, retention across 90 rotating
autosaves, deduplication, exact restoration, orphan retention/admin cleanup, and
account deletion. History/restore access is isolated by both user and game.
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
