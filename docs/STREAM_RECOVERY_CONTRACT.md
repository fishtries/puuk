# Stream recovery contract

`GET /api/stream/{track_id}` is SQLite-first. For a track already present in
SQLite, playback resolves its stored `file_path` and serves the local file with
`FileResponse`; it does not query Qdrant. A missing local file for a known row
returns `404` and does not trigger a Qdrant lookup.

If the SQLite row is missing, one recovery attempt may consult Qdrant for that
track. Recovery succeeds only when the payload resolves to an existing file
inside the configured music directory. Only then may the track be registered
in SQLite and streamed. Missing, invalid, or out-of-directory files return
`404` without creating a placeholder row. `/api/media-ticket` uses the same
recovery behavior before issuing a ticket, so tickets are not issued for
unplayable tracks.

The stream router logs SQLite versus recovery file-resolution paths and the
recovery outcome/duration separately under `puuk.streaming`. These timings
cover lookup and path resolution, not the duration of the subsequent file
transfer. Qdrant timeout/error policy is tracked separately; this contract
does not make Qdrant part of the normal playback path.

Regression coverage lives in `brain/test_media_ticket.py` and
`brain/test_track_recovery.py`.
