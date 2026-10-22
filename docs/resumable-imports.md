# Resumable game imports

The browser importer transfers `.zip`, `.tar.bz2` and `.rar` archives in sequential
chunks of at most 16 MiB. It creates a durable Jobs entry before transferring file
data. URL imports remain server-side downloads; the old multipart endpoint remains
available to older clients.

## Upload and recovery

The browser first reads the archive in a worker to compute its SHA-256 identity.
This local check can take time for a large archive; its progress is shown separately
from network transfer. Each chunk also has a checksum. Only bytes written, synced
to disk and recorded in the database count as **server confirmed**. Bytes merely
sent by the browser are shown separately.

After an interrupted request, the client checks the server's confirmed offset
before retrying. A lost acknowledgement does not require resending confirmed
bytes. Transient failures use bounded backoff; HTTP 413 reduces the chunk size,
down to 256 KiB. A request with no upload progress or acknowledgement for 90
seconds is aborted and enters recovery rather than hanging indefinitely.

Closing the importer pauses file transfer. Reopen **Import Game**, select an
unfinished upload, and reselect the same archive. **Jobs → Resume upload** opens
the same flow. Content and size must match; the file is checked again after a
reload. The browser cannot silently reopen a local file after a tab closes.
Only the administrator who created the upload can resume it. Changing accounts
stops an active transfer.

Incomplete uploads expire 24 hours after their last confirmed chunk. A periodic
cleanup marks expired jobs failed and removes staged bytes. **Discard upload**
removes them immediately; administrators can also cancel from Jobs. Expired or
cancelled incomplete uploads need a new upload, rather than a processing retry.

If all bytes are confirmed, **Jobs → Finish upload** submits them without
reselecting the file. Acceptance is idempotent. Whole-archive checksum verification
runs in the background before inspection or extraction. Extraction and library
registration then use the existing background importer and archive validation.
Once accepted, the browser can close while processing continues.

## Diagnostics

The importer shows bytes sent, bytes confirmed, transfer rate, elapsed time,
last network progress, and upload ID. **Download diagnostics** exports these
details and bounded recent failures without tokens or authorization headers.
Browser warnings use `[VNoctis import upload]` with expanded JSON text.
API logs correlate chunk acknowledgements and errors by upload ID and request ID;
the retained job log records confirmed progress and subsequent processing.

These details help distinguish a browser/network stall, proxy rejection, server
write failure and archive-processing failure. They do not establish the cause of
any earlier office-network failures; those require evidence from that deployment.

## Storage and deployment

Deploy the API and UI together. API startup applies the new `ImportUpload` SQLite
migration. No builder image change or game rebuild is required. Keep `/data`
persistent: staged chunks live in `/data/import-jobs/<upload-id>/`, with the offset
ledger in the database. Existing Jobs logs and processing cleanup still apply.

The total archive limit remains `MAX_IMPORT_SIZE_MB` (default 24576 MiB). Up to ten
unfinished uploads are allowed per administrator. Chunk buffers are bounded by
16 MiB per concurrent request; the whole archive is not buffered in browser or API
memory. The server still needs space for the staged archive and extracted game.

External proxies must permit the chunk requests and suitable idle timeouts.
Smaller requests reduce the cost of connection failures, but cannot repair a
network or proxy that prevents all uploads. Larger body limits remain necessary
for legacy multipart imports and save-backup ZIP imports if those are used.

## Validation

API coverage exercises ownership, admin access, idempotent creation/completion,
checksums, offsets, duplicate chunks, concurrent retries, restart recovery,
uncommitted disk tails, cancellation and expiry. Client coverage exercises lost
acknowledgements, pause/resume, bounded retries, proxy limits, account changes,
wrong-file selection and idle detection.

Production-image browser checks additionally cover real worker hashing and
extraction through Nginx, discarding a successful chunk acknowledgement, resuming
after an API restart and page reload, and reducing chunks after proxy rejection.
