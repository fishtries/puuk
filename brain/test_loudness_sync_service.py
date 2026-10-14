"""Focused tests for server-side loudness delivery (Qdrant -> server SQLite).

Covers real-disk identity validation, path safety, SFTP second-resolution
mtime, finite-metric validation, idempotency, version upgrades, pagination,
outage isolation, client lifecycle and the periodic API task. No live Qdrant is
contacted: the client is always injected or patched, and every "audio file" is a
real temporary file inside a patched music root.
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.dirname(__file__))
import test_db_path  # noqa: F401 — isolates test DB, disables live sync

import db
from services.loudness_sync_service import (
    LoudnessSyncError,
    _identity_matches,
    _resolve_audio_file,
    _validated_metrics,
    run_loudness_sync,
    sync_loudness_from_qdrant,
)

NS = 1_000_000_000


def _record(track_id, payload):
    return SimpleNamespace(id=track_id, payload=payload)


def _analyzed_payload(size, mtime_ns, *, gain=2.5, lufs=-16.0, tp=-1.2, version="r128-v1", **extra):
    payload = {
        "loudness_status": "analyzed",
        "loudness_lufs": lufs,
        "true_peak_db": tp,
        "normalization_gain_db": gain,
        "loudness_analysis_version": version,
        "loudness_file_size": size,
        "loudness_file_mtime_ns": mtime_ns,
    }
    payload.update(extra)
    return payload


def _client(records, next_page=None):
    return SimpleNamespace(scroll=lambda **kwargs: (records, next_page))


class LoudnessSyncTestBase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="puuk_lsync_")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        patcher = patch(
            "services.loudness_sync_service.get_effective_music_dir", return_value=self.root
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _make_file(self, rel_name, content=b"audio-bytes", mtime_ns=None):
        path = Path(self.root) / rel_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        if mtime_ns is not None:
            os.utime(path, ns=(mtime_ns, mtime_ns))
        stat = path.stat()
        return str(rel_name), stat.st_size, stat.st_mtime_ns

    def _add_track(self, track_id, rel_name, file_size, file_mtime_ns):
        db.add_or_update_track(
            track_id, rel_name, "Title", None, "Artist",
            file_size=file_size, file_mtime_ns=file_mtime_ns,
        )

    def _force_analysis(self, track_id, *, version, size, mtime_ns, gain=0.0):
        conn = db.get_connection()
        conn.execute(
            """UPDATE tracks SET loudness_status='analyzed', loudness_lufs=-10.0,
               true_peak_db=-1.0, normalization_gain_db=?,
               loudness_analysis_version=?, loudness_file_size=?,
               loudness_file_mtime_ns=? WHERE id=?""",
            (gain, version, size, mtime_ns, track_id),
        )
        conn.commit()
        conn.close()


class TestLoudnessSyncService(LoudnessSyncTestBase):
    def test_applies_result_and_preserves_real_nanosecond_identity(self):
        track_id = "lsync-apply-1"
        rel, size, mtime = self._make_file("a.mp3")
        self._add_track(track_id, rel, size, mtime)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(size, mtime))])
        )

        self.assertEqual(counters["synced"], 1)
        track = db.get_track(track_id)
        self.assertEqual(track["loudness_status"], "analyzed")
        self.assertEqual(track["normalization_gain_db"], 2.5)
        self.assertEqual(track["loudness_lufs"], -16.0)
        self.assertEqual(track["true_peak_db"], -1.2)
        # The real server stat (ns) is written to both identity column groups.
        self.assertEqual(track["file_mtime_ns"], mtime)
        self.assertEqual(track["loudness_file_mtime_ns"], mtime)
        self.assertEqual(track["loudness_file_size"], size)

    def test_second_truncated_mtime_is_accepted(self):
        track_id = "lsync-seconds-1"
        rel, size, mtime = self._make_file("b.mp3", mtime_ns=1_700_000_000 * NS + 500_000_000)
        self._add_track(track_id, rel, size, mtime)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(size, 1_700_000_000 * NS))])
        )

        self.assertEqual(counters["synced"], 1)
        self.assertEqual(db.get_track(track_id)["file_mtime_ns"], mtime)

    def test_same_second_precise_mtime_mismatch_is_rejected(self):
        track_id = "lsync-precise-1"
        disk_mtime = 1_700_000_000 * NS + 500_000_000
        rel, size, mtime = self._make_file("c.mp3", mtime_ns=disk_mtime)
        self._add_track(track_id, rel, size, mtime)
        # Same second, but a full-resolution timestamp that differs -> stale.
        payload_mtime = disk_mtime + 100_000_000
        self.assertNotEqual(payload_mtime % NS, 0)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(size, payload_mtime))])
        )

        self.assertEqual(counters["skipped_stale"], 1)
        self.assertEqual(db.get_track(track_id)["loudness_status"], "pending")

    def test_missing_file_is_rejected(self):
        track_id = "lsync-missing-1"
        self._add_track(track_id, "gone.mp3", 1000, 100 * NS)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(1000, 100 * NS))])
        )

        self.assertEqual(counters["skipped_missing_file"], 1)
        self.assertEqual(db.get_track(track_id)["loudness_status"], "pending")

    def test_path_traversal_is_rejected(self):
        outside = Path(self.root).parent / "outside_lsync.mp3"
        outside.write_bytes(b"outside")
        self.addCleanup(lambda: outside.exists() and outside.unlink())
        stat = outside.stat()

        track_id = "lsync-escape-1"
        self._add_track(track_id, "../outside_lsync.mp3", stat.st_size, stat.st_mtime_ns)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(stat.st_size, stat.st_mtime_ns))])
        )

        self.assertEqual(counters["skipped_missing_file"], 1)
        self.assertEqual(db.get_track(track_id)["loudness_status"], "pending")
        self.assertIsNone(_resolve_audio_file("../outside_lsync.mp3", self.root))

    def test_real_disk_stale_is_rejected_even_when_catalog_matches_payload(self):
        track_id = "lsync-disk-stale-1"
        rel, size, mtime = self._make_file("d.mp3", content=b"first")
        self._add_track(track_id, rel, size, mtime)
        # Replace the file on disk; the catalog still holds the old identity.
        (Path(self.root) / rel).write_bytes(b"a completely different length")

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(size, mtime))])
        )

        self.assertEqual(counters["skipped_stale"], 1)
        self.assertEqual(db.get_track(track_id)["loudness_status"], "pending")

    def test_non_finite_metrics_are_rejected(self):
        track_id = "lsync-invalid-1"
        rel, size, mtime = self._make_file("e.mp3")
        self._add_track(track_id, rel, size, mtime)
        for bad in (float("nan"), float("inf"), None, "2.5", True):
            counters = sync_loudness_from_qdrant(
                _client([_record(track_id, _analyzed_payload(size, mtime, gain=bad))])
            )
            self.assertEqual(counters["skipped_invalid"], 1, f"gain={bad!r} should be rejected")
        self.assertIsNone(_validated_metrics({"loudness_lufs": -14.0}))

    def test_missing_payload_identity_is_rejected(self):
        track_id = "lsync-unverifiable-1"
        rel, size, mtime = self._make_file("f.mp3")
        self._add_track(track_id, rel, size, mtime)
        payload = {
            "loudness_status": "analyzed",
            "loudness_lufs": -16.0,
            "true_peak_db": -1.2,
            "normalization_gain_db": 2.5,
            "loudness_analysis_version": "r128-v1",
        }

        counters = sync_loudness_from_qdrant(_client([_record(track_id, payload)]))

        self.assertEqual(counters["skipped_unverifiable"], 1)
        self.assertEqual(db.get_track(track_id)["loudness_status"], "pending")

    def test_result_is_not_rewritten_and_catalog_version_is_stable(self):
        track_id = "lsync-idempotent-1"
        rel, size, mtime = self._make_file("g.mp3")
        self._add_track(track_id, rel, size, mtime)
        client_records = [_record(track_id, _analyzed_payload(size, mtime))]

        first = sync_loudness_from_qdrant(_client(list(client_records)))
        version_after_first = db.get_catalog_version()
        second = sync_loudness_from_qdrant(_client(list(client_records)))
        version_after_second = db.get_catalog_version()

        self.assertEqual(first["synced"], 1)
        self.assertEqual(second["synced"], 0)
        self.assertEqual(second["skipped_unchanged"], 1)
        self.assertEqual(version_after_first, version_after_second)

    def test_newer_server_analysis_is_not_overwritten(self):
        track_id = "lsync-newer-1"
        rel, size, mtime = self._make_file("h.mp3")
        self._add_track(track_id, rel, size, mtime)
        self._force_analysis(track_id, version="r128-v1", size=size, mtime_ns=mtime, gain=0.0)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(size, mtime, gain=9.9))])
        )

        self.assertEqual(counters["skipped_unchanged"], 1)
        self.assertEqual(db.get_track(track_id)["normalization_gain_db"], 0.0)

    def test_version_upgrade_is_applied(self):
        track_id = "lsync-upgrade-1"
        rel, size, mtime = self._make_file("i.mp3")
        self._add_track(track_id, rel, size, mtime)
        self._force_analysis(track_id, version="old-v0", size=size, mtime_ns=mtime)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(size, mtime, version="r128-v1"))])
        )

        self.assertEqual(counters["synced"], 1)
        self.assertEqual(db.get_track(track_id)["loudness_analysis_version"], "r128-v1")

    def test_pagination_reads_all_pages(self):
        first_id, second_id = "lsync-page-1", "lsync-page-2"
        rel1, size1, mtime1 = self._make_file("p1.mp3", content=b"one")
        rel2, size2, mtime2 = self._make_file("p2.mp3", content=b"two-longer")
        self._add_track(first_id, rel1, size1, mtime1)
        self._add_track(second_id, rel2, size2, mtime2)

        pages = [
            ([_record(first_id, _analyzed_payload(size1, mtime1))], "offset-1"),
            ([_record(second_id, _analyzed_payload(size2, mtime2))], None),
        ]
        client = SimpleNamespace(scroll=lambda **kw: pages.pop(0))

        counters = sync_loudness_from_qdrant(client)

        self.assertEqual(counters["synced"], 2)
        self.assertEqual(db.get_track(first_id)["loudness_status"], "analyzed")
        self.assertEqual(db.get_track(second_id)["loudness_status"], "analyzed")

    def test_qdrant_read_error_is_isolated(self):
        def boom(**kwargs):
            raise RuntimeError("qdrant unavailable")

        with self.assertRaises(LoudnessSyncError):
            sync_loudness_from_qdrant(SimpleNamespace(scroll=boom))

    def test_scroll_filters_analyzed_only(self):
        captured = {}

        def scroll(**kwargs):
            captured.update(kwargs)
            return ([], None)

        sync_loudness_from_qdrant(SimpleNamespace(scroll=scroll))

        scroll_filter = captured["scroll_filter"]
        condition = scroll_filter.must[0]
        self.assertEqual(condition.key, "loudness_status")
        self.assertEqual(condition.match.value, "analyzed")

    def test_dry_run_does_not_write(self):
        track_id = "lsync-dryrun-1"
        rel, size, mtime = self._make_file("j.mp3")
        self._add_track(track_id, rel, size, mtime)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, _analyzed_payload(size, mtime))]), dry_run=True
        )

        self.assertEqual(counters["would_sync"], 1)
        self.assertEqual(counters["synced"], 0)
        self.assertEqual(db.get_track(track_id)["loudness_status"], "pending")

    def test_limit_bounds_applied_results(self):
        ids = ["lsync-limit-1", "lsync-limit-2"]
        records = []
        for index, track_id in enumerate(ids):
            rel, size, mtime = self._make_file(f"lim{index}.mp3", content=b"x" * (index + 1))
            self._add_track(track_id, rel, size, mtime)
            records.append(_record(track_id, _analyzed_payload(size, mtime)))

        counters = sync_loudness_from_qdrant(_client(records), limit=1)

        self.assertEqual(counters["synced"], 1)

    def test_missing_track_is_created_only_for_existing_file(self):
        track_id = "lsync-create-1"
        rel, size, mtime = self._make_file("music/New.mp3")
        payload = _analyzed_payload(size, mtime, file_path=rel, title="New", artist="Someone")

        counters = sync_loudness_from_qdrant(_client([_record(track_id, payload)]))

        self.assertEqual(counters["created"], 1)
        self.assertEqual(counters["synced"], 1)
        track = db.get_track(track_id)
        self.assertEqual(track["title"], "New")
        self.assertEqual(track["loudness_status"], "analyzed")
        self.assertEqual(track["file_size"], size)

    def test_no_phantom_track_for_missing_file(self):
        track_id = "lsync-phantom-1"
        payload = _analyzed_payload(1234, 100 * NS, file_path="missing/new.mp3", title="Ghost")

        counters = sync_loudness_from_qdrant(_client([_record(track_id, payload)]))

        self.assertEqual(counters["created"], 0)
        self.assertEqual(counters["skipped_missing_file"], 1)
        self.assertIsNone(db.get_track(track_id))

    def test_create_missing_false_skips_unknown_track(self):
        track_id = "lsync-nocreate-1"
        rel, size, mtime = self._make_file("k.mp3")
        payload = _analyzed_payload(size, mtime, file_path=rel)

        counters = sync_loudness_from_qdrant(
            _client([_record(track_id, payload)]), create_missing=False
        )

        self.assertEqual(counters["skipped_missing_track"], 1)
        self.assertEqual(counters["synced"], 0)
        self.assertIsNone(db.get_track(track_id))

    def test_identity_helper_seconds_vs_exact(self):
        self.assertTrue(_identity_matches(10, 1_700_000_000 * NS, 10, 1_700_000_000 * NS + 5))
        self.assertFalse(_identity_matches(10, 1_700_000_000 * NS, 11, 1_700_000_000 * NS))
        precise = 1_700_000_000 * NS + 500_000_000
        self.assertTrue(_identity_matches(10, precise, 10, precise))
        self.assertFalse(_identity_matches(10, precise, 10, precise + 1))


class TestRunLoudnessSync(LoudnessSyncTestBase):
    def test_closes_client_after_pass(self):
        client = Mock()
        with patch("services.loudness_sync_service.get_qdrant_client", return_value=client), \
             patch("services.loudness_sync_service.sync_loudness_from_qdrant",
                   return_value={"synced": 1}):
            result = run_loudness_sync(create_missing=False)

        self.assertEqual(result["synced"], 1)
        client.close.assert_called_once()

    def test_closes_client_even_when_pass_raises(self):
        client = Mock()
        with patch("services.loudness_sync_service.get_qdrant_client", return_value=client), \
             patch("services.loudness_sync_service.sync_loudness_from_qdrant",
                   side_effect=LoudnessSyncError("down")):
            with self.assertRaises(LoudnessSyncError):
                run_loudness_sync()

        client.close.assert_called_once()


class TestLoudnessSyncLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_loop_runs_a_pass_then_sleeps(self):
        import api

        calls = []

        def fake_run(**kwargs):
            calls.append(kwargs)
            return {"synced": 3, "failed": 0}

        with patch("services.loudness_sync_service.run_loudness_sync", side_effect=fake_run):
            task = asyncio.create_task(api._loudness_sync_loop())
            await asyncio.sleep(0.05)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertEqual(len(calls), 1)
        self.assertFalse(calls[0].get("create_missing", True))

    async def test_loop_survives_qdrant_error(self):
        import api

        def failing_run(**kwargs):
            raise LoudnessSyncError("qdrant down")

        with patch("services.loudness_sync_service.run_loudness_sync", side_effect=failing_run):
            task = asyncio.create_task(api._loudness_sync_loop())
            await asyncio.sleep(0.05)
            self.assertFalse(task.done())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task


if __name__ == "__main__":
    unittest.main()
