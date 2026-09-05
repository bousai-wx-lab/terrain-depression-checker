#!/usr/bin/env python3
"""Harmless rejection tests; fixtures never leave the local temporary directory."""

from __future__ import annotations

import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import build_pages_artifact as pages
import privacy_gate as gate


class PagesReleaseTests(unittest.TestCase):
    def test_exact_and_deterministic_archive(self):
        files = {"index.html": b"example", ".nojekyll": b"", "data/sample.json": b"{}"}
        with tempfile.TemporaryDirectory() as tmp:
            first = pages.build_archive(Path(tmp) / "first", files)
            second = pages.build_archive(Path(tmp) / "second", files)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            pages.verify_archive(first, files)
            with self.assertRaises(FileExistsError):
                pages.build_archive(Path(tmp) / "first", files)

    def test_archive_rejections(self):
        expected = {"index.html": b"example"}
        for case in ("extra", "missing", "changed", "duplicate", "symlink", "metadata", "traversal"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / "artifact.tar"
                with tarfile.open(archive, "w", format=tarfile.USTAR_FORMAT) as bundle:
                    root = tarfile.TarInfo(".")
                    root.type = tarfile.DIRTYPE
                    root.mode = 0o755
                    bundle.addfile(root)
                    names = [] if case == "missing" else ["index.html"]
                    if case == "extra":
                        names.append("unlisted.txt")
                    if case == "duplicate":
                        names.append("index.html")
                    for name in names:
                        member = tarfile.TarInfo("./../index.html" if case == "traversal" else "./" + name)
                        data = b"changed" if case == "changed" else b"example"
                        member.size = len(data)
                        member.mode = 0o644
                        if case == "symlink":
                            member.type = tarfile.SYMTYPE
                            member.linkname = "elsewhere"
                        if case == "metadata":
                            member.uname = "sample"
                        bundle.addfile(member, io.BytesIO(data))
                with self.assertRaises(ValueError):
                    pages.verify_archive(archive, expected)

    def test_release_inventory_rejections(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "index.html").write_bytes(b"example")
            allowed = {"allowed_files": [*pages.EXCLUDED, "index.html"]}
            self.assertEqual(pages.release_files(root, allowed), {"index.html": b"example"})
            for name in ("../elsewhere", "/elsewhere", "missing", "index.html"):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    pages.release_files(root, {"allowed_files": [*allowed["allowed_files"], name]})
            (root / "link").symlink_to(root / "index.html")
            with self.assertRaises(ValueError):
                pages.release_files(root, {"allowed_files": [*allowed["allowed_files"], "link"]})

    def test_real_privacy_gate_rejects_unlisted_probe(self):
        allowlist = json.loads(gate.ALLOWLIST_PATH.read_text())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "publication-block-test.txt").touch()
            with patch.object(gate, "ROOT", root):
                findings = gate.validate_worktree(allowlist)
            probe_label = "file@" + gate.digest_bytes(b"publication-block-test.txt")[:12]
            self.assertTrue(any("not allowlisted" in item and probe_label in item for item in findings))

    def test_workflow_dependencies(self):
        workflow = (gate.ROOT / ".github/workflows/privacy-gate.yml").read_text()
        self.assertIn("needs: verify-public-surface", workflow)
        self.assertIn("needs: [verify-public-surface, build-pages-artifact]", workflow)
        self.assertIn("needs.verify-public-surface.result == 'success'", workflow)
        self.assertIn("needs.build-pages-artifact.result == 'success'", workflow)
        self.assertNotIn("continue-on-error", workflow)
        self.assertNotIn("always()", workflow)
        self.assertNotIn("pull_request_target", workflow)
        self.assertEqual(workflow.count("pages: write"), 1)
        self.assertEqual(workflow.count("id-token: write"), 1)
        self.assertEqual(workflow.count("persist-credentials: false"), 2)
        self.assertIn("github-pages-${{ github.run_id }}-${{ github.run_attempt }}", workflow)


if __name__ == "__main__":
    unittest.main()
