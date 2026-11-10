#!/usr/bin/env python3
"""Import verified word-level lyrics into Puuk SQLite database.

Dry-run by default. Use --apply to execute transaction.
Validates Contract v1, verifies track exists, verifies audio SHA-256 and captures
file stat signature (size + mtime_ns). Backs up existing snapshot if replaced.
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
from typing import Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "brain"))
import db
from services.media_locations import resolve_existing_file_path
from services.word_lyrics_validator import validate_word_lyrics_payload


def compute_file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def import_word_lyrics_file(
    input_path: str,
    audio_path: Optional[str] = None,
    provenance_path: Optional[str] = None,
    apply_changes: bool = False,
    backup_dir: Optional[str] = None,
    is_active: bool = True,
) -> dict:
    """
    Validates and imports wordLyrics JSON file into track_word_lyrics table.

    Returns dict with summary and status.
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")

    with open(input_path, "r", encoding="utf-8") as f:
        raw_data = json.load(f)

    # Allow either {"wordLyrics": {...}} or root payload
    if "wordLyrics" in raw_data and isinstance(raw_data["wordLyrics"], dict):
        payload = raw_data["wordLyrics"]
    else:
        payload = raw_data

    track_id = payload.get("trackId")
    if not track_id:
        raise ValueError("Payload missing trackId")

    # 1. Verify track exists in database
    db_track = db.get_track(track_id)
    if not db_track:
        raise ValueError(f"Track '{track_id}' not found in Puuk database")

    # 2. Locate and verify audio file
    resolved_audio = None
    if audio_path:
        if not os.path.isfile(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        resolved_audio = os.path.abspath(audio_path)
    else:
        file_path_db = db_track.get("file_path")
        if file_path_db:
            if os.path.isabs(file_path_db) and os.path.exists(file_path_db):
                resolved_audio = file_path_db
            else:
                resolved_audio = resolve_existing_file_path(file_path_db)

    if not resolved_audio or not os.path.exists(resolved_audio):
        raise FileNotFoundError(f"Audio file for track '{track_id}' not found (db path: {db_track.get('file_path')})")

    track_audio = db_track.get("file_path") or ""
    if not os.path.isabs(track_audio) or not os.path.isfile(track_audio):
        track_audio = resolve_existing_file_path(track_audio)
    if not track_audio or os.path.realpath(track_audio) != os.path.realpath(resolved_audio):
        raise ValueError("--audio must identify the current track audio file")

    # Audio SHA-256 and stat signature
    actual_audio_sha256 = compute_file_sha256(resolved_audio)
    expected_audio_sha256 = payload.get("audioSha256")
    if not expected_audio_sha256 or actual_audio_sha256.lower() != expected_audio_sha256.lower():
        raise ValueError(
            f"Audio SHA-256 mismatch for track '{track_id}':\n"
            f"  File ({resolved_audio}): {actual_audio_sha256}\n"
            f"  Payload: {expected_audio_sha256}"
        )

    st = os.stat(resolved_audio)
    file_size = st.st_size
    file_mtime_ns = st.st_mtime_ns

    # 3. Validate against Contract v1
    is_valid, error = validate_word_lyrics_payload(
        payload,
        expected_track_id=track_id,
        expected_audio_sha256=actual_audio_sha256,
        verify_revision=True,
    )
    if not is_valid:
        raise ValueError(f"Payload validation failed: {error}")

    revision = payload["revision"]
    schema_version = payload["schemaVersion"]
    payload_json = json.dumps(payload, ensure_ascii=False)

    # Provenance
    provenance_json = None
    if provenance_path and os.path.exists(provenance_path):
        with open(provenance_path, "r", encoding="utf-8") as pf:
            provenance_json = json.dumps(json.load(pf), ensure_ascii=False)

    # 4. Check existing snapshot in DB
    existing = db.get_track_word_lyrics_record(track_id)
    if existing:
        if (existing["revision"] == revision and existing["payload_json"] == payload_json
                and bool(existing.get("is_active")) == is_active
                and existing["file_path"] == resolved_audio
                and existing["file_size"] == file_size
                and existing["file_mtime_ns"] == file_mtime_ns):
            return {
                "status": "noop_identical_revision",
                "track_id": track_id,
                "revision": revision,
                "applied": False,
                "message": f"Revision {revision} already stored with the requested activity for track {track_id}. No changes needed.",
            }

        # Backup existing snapshot before replacement
        if apply_changes:
            backup_data = {
                "backup_reason": f"Replacing revision {existing['revision']} with {revision}",
                "track_id": track_id,
                "previous_record": existing,
            }
            target_backup_dir = backup_dir or "/tmp/puuk_lyrics_backups"
            os.makedirs(target_backup_dir, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=target_backup_dir,
                prefix="word-lyrics-", suffix=".json", delete=False,
            ) as bf:
                json.dump(backup_data, bf, ensure_ascii=False, indent=2)
                backup_file = bf.name
            print(f"[Backup] Saved previous snapshot to: {backup_file}", file=sys.stderr)

    if not apply_changes:
        return {
            "status": "dry_run",
            "track_id": track_id,
            "revision": revision,
            "lines_count": len(payload.get("lines", [])),
            "words_count": sum(len(l.get("words", [])) for l in payload.get("lines", [])),
            "audio_file": resolved_audio,
            "file_size": file_size,
            "file_mtime_ns": file_mtime_ns,
            "applied": False,
            "message": "Dry-run completed successfully. Re-run with --apply to commit to database.",
        }

    # 5. Atomic write to SQLite
    db.upsert_track_word_lyrics(
        track_id=track_id,
        payload_json=payload_json,
        revision=revision,
        audio_sha256=actual_audio_sha256,
        file_path=resolved_audio,
        file_size=file_size,
        file_mtime_ns=file_mtime_ns,
        provenance_json=provenance_json,
        schema_version=schema_version,
        is_active=int(is_active),
    )

    return {
        "status": "success",
        "track_id": track_id,
        "revision": revision,
        "lines_count": len(payload.get("lines", [])),
        "words_count": sum(len(l.get("words", [])) for l in payload.get("lines", [])),
        "audio_file": resolved_audio,
        "applied": True,
        "message": f"Successfully imported wordLyrics revision {revision} for track {track_id}.",
    }


def main():
    parser = argparse.ArgumentParser(description="Import word lyrics into Puuk SQLite database")
    parser.add_argument("--input", help="Path to wordLyrics JSON")
    parser.add_argument("--audio", help="Optional path to the current track audio file (must match DB path)")
    parser.add_argument("--provenance", help="Optional path to provenance JSON")
    parser.add_argument("--apply", action="store_true", help="Apply changes to database (default is dry-run)")
    parser.add_argument("--backup-dir", help="Directory for backup before replacement")
    parser.add_argument("--track-id")
    parser.add_argument("--deactivate", action="store_true")
    parser.add_argument("--restore", help="Backup JSON produced before replacement")
    args = parser.parse_args()
    if args.deactivate:
        if not args.track_id or args.input or args.restore:
            parser.error("--deactivate requires --track-id only")
        if not db.get_track_word_lyrics_record(args.track_id):
            parser.error("Snapshot not found")
        if args.apply:
            db.set_track_word_lyrics_active(args.track_id, False)
        print(json.dumps({"track_id": args.track_id, "deactivated": args.apply, "dry_run": not args.apply}))
        return
    if args.restore:
        with open(args.restore, encoding="utf-8") as source:
            record = json.load(source)["previous_record"]
        with tempfile.TemporaryDirectory(prefix="puuk-restore-") as tmp:
            snapshot = os.path.join(tmp, "snapshot.json")
            provenance = os.path.join(tmp, "provenance.json")
            with open(snapshot, "w", encoding="utf-8") as out:
                out.write(record["payload_json"])
            with open(provenance, "w", encoding="utf-8") as out:
                out.write(record.get("provenance_json") or "{}")
            result = import_word_lyrics_file(snapshot, provenance_path=provenance,
                apply_changes=args.apply, backup_dir=args.backup_dir,
                is_active=bool(record["is_active"]))
            print(json.dumps(result))
        return
    if not args.input:
        parser.error("--input is required for import")

    try:
        res = import_word_lyrics_file(
            input_path=args.input,
            audio_path=args.audio,
            provenance_path=args.provenance,
            apply_changes=args.apply,
            backup_dir=args.backup_dir,
        )
        print(json.dumps(res, indent=2, ensure_ascii=False))
        if not res["applied"] and res["status"] == "dry_run":
            sys.exit(0)
    except Exception as e:
        print(f"Error during import: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
