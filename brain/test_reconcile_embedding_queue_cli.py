"""CLI contract tests for reconcile_embedding_queue.py (no live Qdrant)."""
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import test_db_path  # noqa: F401 — isolates test DB, disables live queue delivery

import reconcile_embedding_queue as cli
from services.embedding_queue_service import EmbeddingQueueError


class TestReconcileCli(unittest.TestCase):
    def _run(self, argv, service_patch):
        with patch("services.embedding_queue_service.get_qdrant_client", return_value=object()), \
             patch("services.embedding_queue_service.reconcile_embedding_queue", **service_patch), \
             patch.object(sys, "argv", ["reconcile_embedding_queue.py"] + argv):
            return cli.main()

    def test_dry_run_forwards_flags_and_exits_zero(self):
        counters = {"examined": 5, "existing": 2, "enqueued": 0, "would_enqueue": 3,
                    "missing_file": 0, "invalid_id": 0, "failed": 0, "dry_run": True}

        with patch("services.embedding_queue_service.get_qdrant_client", return_value=object()), \
             patch("services.embedding_queue_service.reconcile_embedding_queue",
                   return_value=counters) as reconcile_mock, \
             patch.object(sys, "argv", ["reconcile_embedding_queue.py", "--dry-run", "--limit", "3"]):
            code = cli.main()

        self.assertEqual(code, 0)
        kwargs = reconcile_mock.call_args.kwargs
        self.assertTrue(kwargs["dry_run"])
        self.assertEqual(kwargs["limit"], 3)

    def test_qdrant_error_exits_nonzero(self):
        code = self._run(
            [],
            {"side_effect": EmbeddingQueueError("qdrant down")},
        )
        self.assertEqual(code, 1)

    def test_failed_points_exit_nonzero(self):
        counters = {"examined": 1, "existing": 0, "enqueued": 0, "would_enqueue": 1,
                    "missing_file": 0, "invalid_id": 0, "failed": 1}
        code = self._run([], {"return_value": counters})
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
