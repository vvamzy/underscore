import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class RetentionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = tempfile.TemporaryDirectory(prefix="underscore-retention-")
        cls.addClassCleanup(root.cleanup)
        with patch.dict(os.environ, UNDERSCORE_OUTPUT_DIR=root.name, UNDERSCORE_KEEP_JOBS=""):
            cls.server = importlib.import_module("server")

    def setUp(self):
        root = tempfile.TemporaryDirectory(prefix="underscore-output-")
        self.addCleanup(root.cleanup)
        self.output = Path(root.name)
        output_patch = patch.object(self.server, "OUTPUT", self.output)
        output_patch.start()
        self.addCleanup(output_patch.stop)

    def job(self, jid, *, timestamp, complete=True):
        path = self.output / jid
        path.mkdir()
        (path / "karaoke.wav").touch()
        if complete:
            (path / "vocals.wav").touch()
        os.utime(path, (timestamp, timestamp))
        return path

    def test_retention_is_off_by_default_and_invalid_values_do_not_prune(self):
        self.job("000000000001", timestamp=1000)
        self.job("000000000002", timestamp=2000)
        with patch.dict(os.environ):
            os.environ.pop("UNDERSCORE_KEEP_JOBS", None)
            self.server._prune_output()
        for value in ("0", "-1", "all"):
            with self.subTest(value=value), patch.dict(os.environ, UNDERSCORE_KEEP_JOBS=value):
                with self.assertLogs(self.server.logger, level="WARNING"):
                    self.server._prune_output()
        self.assertEqual(len(list(self.output.iterdir())), 2)

    def test_opt_in_prunes_only_older_completed_jobs(self):
        old = self.job("000000000001", timestamp=1000)
        recent = self.job("000000000002", timestamp=2000)
        partial = self.job("000000000003", timestamp=3000, complete=False)
        unrelated = self.job("my-audio", timestamp=4000)
        with patch.dict(os.environ, UNDERSCORE_KEEP_JOBS="1"):
            self.server._prune_output()
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(partial.exists())
        self.assertTrue(unrelated.exists())

    def test_legacy_jobs_still_have_a_timestamp(self):
        self.job("000000000001", timestamp=1000)
        [job] = self.server.past_jobs()["jobs"]
        self.assertTrue(job["has_karaoke"] and job["has_vocals"])
        self.assertEqual(job["timestamp"], "1970-01-01T00:16:40+00:00")
