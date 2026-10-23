# Resumable game imports

The browser imports `.zip`, `.tar.bz2` and `.rar` archives through a bounded
pipeline. It creates a durable Jobs entry before transferring data, then prepares
and sends chunks immediately. There is no whole-archive scan before upload and
no re-scan of confirmed bytes when resuming.

## Transfer and verification

Up to three requests are in flight, with chunks of at most 16 MiB. A worker
prepares the next chunk checksum while earlier requests transfer or await durable
confirmation. HTTPS uses native SHA-256 where available; plain HTTP uses the
worker fallback. Each received chunk is verified before writing, synced to disk,
and recorded in the database before it counts as confirmed.

Chunks may arrive out of order. The server retains verified ranges beyond the
contiguous prefix, bounded to a 48 MiB window and 256 pending ranges. A missing
range cannot be mistaken for received data merely because a sparse file has the
expected size. Retried chunks are checked against confirmed bytes or their
pending receipt, so a lost acknowledgement need not resend accepted data.

The client retains at most three in-flight chunks plus one being prepared;
server request bodies are bounded to 16 MiB each. Transient failures use bounded
backoff. HTTP 413 reduces chunks down to 256 KiB. A request with no upload
progress or acknowledgement for 90 seconds enters recovery. The pipeline reduces
idle gaps but cannot guarantee saturation when client CPU, disk, proxy or network
capacity is the bottleneck.

## Resume and cleanup

Close or pause the importer, reopen **Import Game** (or **Jobs → Resume upload**),
and reselect the original archive. Uploads match by administrator, archive name
and size. There is deliberately no full content-identity check: selecting a
different same-name/same-size file can produce a mixed archive. Chunk hashes
verify transmitted bytes, not the identity of a reselected file. The user is
responsible for selecting the original archive.

**Discard upload** or Jobs **Cancel** removes unfinished staged data. Start a new
upload afterward. Confirmed progress survives browser reloads and API restarts
for 24 hours after the last confirmed chunk; expiry marks the job failed and
removes staged bytes. Cancelled/expired partial uploads need a new upload.

When every byte is durably accounted for, **Jobs → Finish upload** can queue the
archive without selecting a file again. Completion is idempotent. New uploads
need no second whole-file checksum pass: verification already happened per chunk.
Archive inspection, extractor integrity checks and library registration run in
background jobs. Archive validation failure appears in Jobs; removing that failed
job removes its staging files, allowing a fresh upload.

URL imports remain server-side downloads. Legacy multipart uploads remain
supported. Older resumable uploads retain their original whole-file checksum and
sequential protocol, and can finish after the update.

## Diagnostics and deployment

The UI shows one upload progress pass with sent and server-confirmed bytes, rate,
elapsed time and upload ID. Token-free diagnostic downloads and retained job/API
logs correlate interruptions and confirmed ranges. Transfer confirmation is
separate from background archive processing.

Deploy API and UI together. API startup applies the `pendingChunks` SQLite
migration. Keep `/data` persistent: the archive lives in
`/data/import-jobs/<upload-id>/` and the durable range ledger in the database.
No builder change or game rebuild is required for this upload update.

The total archive limit remains `MAX_IMPORT_SIZE_MB` (default 24576 MiB), with up
to ten unfinished uploads per administrator. External proxies must permit chunk
requests and suitable idle timeouts. Larger request limits still apply to legacy
multipart uploads and save-backup ZIP imports. Disk space is required for the
staged archive and extracted game.

## Validation

API coverage exercises ownership, checksums, durable offsets, out-of-order ranges,
duplicate/overlapping chunks, restart/crash-tail recovery, cancellation, expiry,
and compatibility with the original protocol. Client coverage verifies pipeline
overlap before earlier acknowledgements, no whole-file scan, trusted name/size
resume, lost acknowledgements, bounded retries, proxy limits and account changes.
Production-image browser checks exercise actual worker hashing, Nginx, extraction,
API restart/resume and proxy rejection. Office-network throughput still needs
validation on that deployment.
