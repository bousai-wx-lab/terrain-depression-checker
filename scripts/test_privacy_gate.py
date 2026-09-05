#!/usr/bin/env python3
"""Regression checks for the release privacy gate scanners."""

from __future__ import annotations

import importlib.util
import gzip
import hashlib
import json
import subprocess
import tempfile
import unittest
from copy import deepcopy
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("privacy_gate.py")
SPEC = importlib.util.spec_from_file_location("release_privacy_gate", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise SystemExit("privacy gate module could not be loaded")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SOURCE_ROOT = MODULE.ROOT


class GitObjectTests(unittest.TestCase):
    def setUp(self):
        # Outside the public tree, inside the owning tool's working directory.
        self.temp = tempfile.TemporaryDirectory(prefix=".privacy-regression-", dir=SOURCE_ROOT.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addCleanup(setattr, MODULE, "ROOT", SOURCE_ROOT)
        MODULE.ROOT = self.root
        self.git("init", "--quiet", "--initial-branch=main")
        self.identity = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>"
        self.allow = {
            "allowed_git_identities": [{"name": "github-actions[bot]", "email": "41898282+github-actions[bot]@users.noreply.github.com"}],
            "allowed_external_hosts": [], "allowed_remote_urls": [], "allowed_binary_assets": [],
            "allowed_historical_binary_assets": [],
            "allowed_files": ["safe.js", "large.json"], "large_text_files": {"large.json": 5000}, "max_file_bytes": 1000,
        }
        self.blob = self.object("blob", b"const safe = 1;\n")
        self.tree = self.tree_object("safe.js", self.blob)
        self.commit = self.commit_object(self.tree)
        self.git("update-ref", "refs/heads/main", self.commit)

    def git(self, *args, data=None):
        return subprocess.run(["git", "-C", str(self.root), *args], input=data, capture_output=True, check=True).stdout

    def object(self, kind, data):
        return self.git("hash-object", "-t", kind, "-w", "--stdin", data=data).decode().strip()

    def tree_object(self, name, child, mode="100644"):
        return self.object("tree", mode.encode() + b" " + name.encode() + b"\x00" + bytes.fromhex(child))

    def commit_object(self, tree, author=None, committer=None, message="Safe fixture"):
        data = f"tree {tree}\nauthor {author or self.identity} 1700000000 +0000\ncommitter {committer or self.identity} 1700000000 +0000\n\n{message}\n"
        return self.object("commit", data.encode())

    def findings(self):
        return MODULE.validate_git(self.allow)

    def test_safe_reachable_and_detached_objects_pass(self):
        self.commit_object(self.tree, message="Detached safe fixture")
        self.tree_object("独立.txt", self.object("blob", "検査用の公開文".encode()))
        self.assertEqual(self.findings(), [])

    def test_unreachable_author_with_allowed_email_but_unapproved_name(self):
        self.commit_object(self.tree, author=self.identity.replace("github-actions[bot]", "Unapproved", 1))
        self.assertTrue(any("author identity" in item for item in self.findings()))

    def test_unreachable_committer_with_allowed_email_but_unapproved_name(self):
        self.commit_object(self.tree, committer=self.identity.replace("github-actions[bot]", "Unapproved", 1))
        self.assertTrue(any("committer identity" in item for item in self.findings()))

    def test_unreachable_annotated_tagger(self):
        tagger = self.identity.replace("github-actions[bot]", "Unapproved", 1)
        self.object("tag", f"object {self.commit}\ntype commit\ntag fixture\ntagger {tagger} 1700000000 +0000\n\nSafe fixture\n".encode())
        self.assertTrue(any("tagger identity" in item for item in self.findings()))

    def test_safe_annotated_tagger(self):
        self.object("tag", f"object {self.commit}\ntype commit\ntag fixture\ntagger {self.identity} 1700000000 +0000\n\nSafe fixture\n".encode())
        self.assertEqual(self.findings(), [])

    def test_detached_tree_name_is_scanned_without_quoting(self):
        name = "検査_" + "person" + "@" + "example.com" + ".txt"
        self.tree_object(name, self.blob)
        findings = self.findings()
        self.assertTrue(any("unapproved email" in item for item in findings))
        self.assertNotIn(name, "\n".join(findings))

    def test_nested_detached_tree_path(self):
        nested = self.tree_object("file.txt", self.blob)
        nested = self.tree_object("sample", nested, "40000")
        self.tree_object("Us" + "ers", nested, "40000")
        self.assertTrue(any("local path" in item for item in self.findings()))

    def test_detached_browser_blob_keeps_extension(self):
        dangerous = self.object("blob", ("document." + "write('fixture');").encode())
        self.tree_object("removed.js", dangerous)
        self.assertTrue(any("dangerous browser API" in item for item in self.findings()))

    def test_standalone_browser_blob_is_conservative(self):
        self.object("blob", ("local" + "Storage.clear();").encode())
        self.assertTrue(any("dangerous browser API" in item for item in self.findings()))

    def test_standalone_secret_blob(self):
        self.object("blob", ("gh" + "p_" + "A" * 40).encode())
        self.assertTrue(any("secret pattern" in item for item in self.findings()))

    def test_symlink_mode(self):
        self.tree_object("link.txt", self.blob, "120000")
        self.assertTrue(any("tree mode" in item for item in self.findings()))

    def test_submodule_mode(self):
        self.tree_object("module", self.commit, "160000")
        self.assertTrue(any("tree mode" in item for item in self.findings()))

    def test_env_name_even_without_suffix(self):
        self.tree_object(".env", self.blob)
        self.assertTrue(any("forbidden file type" in item for item in self.findings()))

    def test_invalid_utf8_name_fails_closed(self):
        self.object("tree", b"100644 \xff\x00" + bytes.fromhex(self.blob))
        self.assertTrue(self.findings())

    def test_large_detached_approved_path_passes(self):
        large = self.object("blob", b" " * 1500)
        self.tree_object("large.json", large)
        self.assertEqual(self.findings(), [])

    def test_large_blob_at_unapproved_path_fails(self):
        large = self.object("blob", b" " * 1500)
        self.tree_object("large.json", large)
        self.tree_object("unapproved.json", large)
        self.assertTrue(any("approved path size" in item for item in self.findings()))

    def test_explicit_historical_binary_at_original_path_passes(self):
        data = (SOURCE_ROOT / "assets/bousaiwxlab-site-icon.png").read_bytes()
        blob = self.object("blob", data)
        self.tree_object("historical.png", blob)
        self.allow["allowed_files"].append("historical.png")
        self.allow["allowed_historical_binary_assets"] = [{
            "path": "historical.png",
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "mime_type": "image/png",
            "width": 512,
            "height": 512,
            "bit_depth": 8,
            "color_type": 2,
        }]
        self.assertEqual(self.findings(), [])

    def test_historical_binary_at_another_path_fails(self):
        data = (SOURCE_ROOT / "assets/bousaiwxlab-site-icon.png").read_bytes()
        blob = self.object("blob", data)
        self.tree_object("renamed.png", blob)
        self.allow["allowed_files"].append("historical.png")
        self.allow["allowed_historical_binary_assets"] = [{
            "path": "historical.png",
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "mime_type": "image/png",
            "width": 512,
            "height": 512,
            "bit_depth": 8,
            "color_type": 2,
        }]
        self.assertTrue(any("historical binary asset path mismatch" in item for item in self.findings()))

    def test_packed_unreachable_identity_is_checked(self):
        bad = self.commit_object(self.tree, author=self.identity.replace("github-actions[bot]", "Unapproved", 1))
        self.git("pack-objects", ".git/objects/pack/fixture", data=(bad + "\n").encode())
        # Remove only this disposable fixture's loose copy to prove pack-only
        # inspection, rather than accidentally reading the original loose data.
        loose = self.root / ".git/objects" / bad[:2] / bad[2:]
        loose.unlink()
        self.assertFalse(loose.exists())
        self.assertTrue(any("author identity" in item for item in self.findings()))

    def test_git_command_failures_cannot_pass(self):
        original = MODULE.run_git
        for marker in ("--batch-all-objects", "--batch", "for-each-ref", "fsck", "remote"):
            with self.subTest(marker=marker):
                def fail(args, **kwargs):
                    if marker in args:
                        raise subprocess.CalledProcessError(1, ["git"], stderr=b"not echoed")
                    return original(args, **kwargs)
                with patch.object(MODULE, "run_git", side_effect=fail):
                    self.assertEqual(self.findings(), ["Git inspection could not be completed; release blocked"])

    def test_truncated_batch_cannot_pass(self):
        original = MODULE.run_git
        def truncate(args, **kwargs):
            result = original(args, **kwargs)
            if "--batch" in args:
                result.stdout = result.stdout[:-1]
            return result
        with patch.object(MODULE, "run_git", side_effect=truncate):
            self.assertTrue(self.findings())

    def test_missing_repository_cannot_pass(self):
        with patch.object(MODULE, "ROOT", self.root / "missing"):
            self.assertTrue(self.findings())

    def test_shallow_history_cannot_pass(self):
        original = MODULE.run_git
        def shallow(args, **kwargs):
            result = original(args, **kwargs)
            if "--is-shallow-repository" in args:
                result.stdout = b"true\n"
            return result
        with patch.object(MODULE, "run_git", side_effect=shallow):
            self.assertTrue(self.findings())


class BrowserSecurityTests(unittest.TestCase):
    def test_document_policy_and_disclosure(self):
        class Tags(HTMLParser):
            def __init__(self):
                super().__init__()
                self.tags = []
            def handle_starttag(self, tag, attrs):
                self.tags.append((tag, dict(attrs)))
        html = (SOURCE_ROOT / "index.html").read_text()
        parser = Tags()
        parser.feed(html)
        policies = [attrs["content"] for tag, attrs in parser.tags if tag == "meta" and attrs.get("http-equiv") == "Content-Security-Policy"]
        self.assertEqual(len(policies), 1)
        policy = dict((value.strip().split(" ", 1) + [""])[:2] for value in policies[0].split(";"))
        for key in ("default-src", "base-uri", "object-src", "frame-src", "script-src-attr", "style-src-attr", "form-action"):
            self.assertEqual(policy[key], "'none'")
        for key in ("style-src", "worker-src"):
            self.assertEqual(policy[key], "'self'")
        self.assertEqual(policy["script-src"], "'self'")
        self.assertEqual(policy["script-src-elem"], "'self' https://www.googletagmanager.com")
        self.assertIn("https://*.google-analytics.com", policy["img-src"])
        self.assertIn("https://*.google-analytics.com", policy["connect-src"])
        self.assertIn("https://*.analytics.google.com", policy["connect-src"])
        self.assertNotIn("frame-ancestors", policy)  # Invalid in a meta policy.
        for tag, attrs in parser.tags:
            self.assertFalse(any(key.lower().startswith("on") for key in attrs))
            if tag == "script":
                self.assertEqual(attrs.get("type"), "module")
                self.assertTrue(attrs.get("src", "").startswith("./"))
                self.assertEqual(attrs.get("referrerpolicy"), "no-referrer")
        for phrase in ("クリップボード", "ブラウザ履歴", "通信記録", "IPアドレス", "GitHub Pages", "キャッシュ", "Google Analytics", "アクセス解析の設定"):
            self.assertIn(phrase, html)
        self.assertNotIn("サーバーや端末内へ保存はしません", html)

    def test_exact_analytics_storage_allowance(self):
        allowed = {
            "analytics-consent.js": {
                "localStorage": [
                    "window.localStorage.getItem(CONSENT_STORAGE_KEY)",
                    "window.localStorage.setItem(CONSENT_STORAGE_KEY, value)",
                ]
            }
        }
        safe = "window.localStorage.getItem(CONSENT_STORAGE_KEY); window.localStorage.setItem(CONSENT_STORAGE_KEY, value);"
        self.assertEqual(MODULE.scan_text("analytics-consent.js", safe, set(), set(), allowed), [])
        self.assertTrue(MODULE.scan_text("other.js", safe, set(), set(), allowed))
        self.assertTrue(MODULE.scan_text("analytics-consent.js", safe + " window.localStorage.clear();", set(), set(), allowed))

    def test_request_credentials_and_referrer_contract(self):
        worker = (SOURCE_ROOT / "analysis-worker.js").read_text()
        requests = [line for line in worker.splitlines() if "await fetch(" in line]
        self.assertEqual(len(requests), 3)
        for request in requests:
            for option in ("credentials:'omit'", "referrerPolicy:'no-referrer'", "redirect:'error'", "signal:AbortSignal.timeout(20000)"):
                self.assertIn(option, request)
        app = (SOURCE_ROOT / "app.js").read_text()
        self.assertIn('image.referrerPolicy = "no-referrer"', app)
        self.assertIn('type: "module", credentials: "omit"', app)


def main() -> int:
    allowed_email = "41898282+github-actions[bot]@users.noreply.github.com"
    allowed_hosts = {"maps.gsi.go.jp"}
    local_path = "/" + "Users" + "/sample/work/file.txt"
    token = "gh" + "p_" + "A" * 40
    foreign_email = "person" + "@" + "example.com"
    dangerous_api = "local" + "Storage"

    assert MODULE.scan_text("fixture.txt", local_path, {allowed_email}, allowed_hosts)
    assert MODULE.scan_text("fixture.txt", token, {allowed_email}, allowed_hosts)
    assert MODULE.scan_text("fixture.txt", foreign_email, {allowed_email}, allowed_hosts)
    assert MODULE.scan_text("fixture.js", dangerous_api, {allowed_email}, allowed_hosts)
    unapproved_url = "https://" + "unapproved.example" + "/path"
    assert MODULE.scan_text("fixture.md", unapproved_url, {allowed_email}, allowed_hosts)
    assert not MODULE.scan_text(
        "fixture.md",
        f"{allowed_email} https://maps.gsi.go.jp/development/",
        {allowed_email},
        allowed_hosts,
    )
    asset_path = MODULE.ROOT / "assets/bousaiwxlab-site-icon.png"
    asset_data = asset_path.read_bytes()
    record = {
        "path": "assets/bousaiwxlab-site-icon.png",
        "bytes": 266670,
        "sha256": "f2258fc48adea8bdcf175699fb08b434b039c0aee83a4439c181741f3c2a4c9e",
        "mime_type": "image/png",
        "width": 512,
        "height": 512,
        "bit_depth": 8,
        "color_type": 2,
    }
    assert not MODULE.validate_binary_asset(record["path"], asset_data, record)
    tampered = bytearray(asset_data)
    tampered[-16] ^= 1
    assert MODULE.validate_binary_asset(record["path"], bytes(tampered), record)
    wrong_size = deepcopy(record)
    wrong_size["width"] = 511
    assert MODULE.validate_binary_asset(record["path"], asset_data, wrong_size)
    area={"v":1,"z":8,"x":1,"y":2,"n":128,"e":[0]*16384,"a":[0]*16384}
    raw=json.dumps(area,separators=(",", ":")).encode()
    data=gzip.compress(raw,mtime=0)
    record={"path":"data/area-v1/8/1/2.json.gz","bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),"mime_type":"application/gzip","raw_bytes":len(raw)}
    assert not MODULE.validate_binary_asset(record["path"],data,record)
    for change in ['trailing','metadata','non-numeric','wrong-count','wrong-range']:
        bad=deepcopy(area)
        if change=='non-numeric':bad['e'][0]='unapproved text'
        if change=='wrong-count':bad['e'].pop()
        if change=='wrong-range':bad['a'][0]=1000000001
        payload=json.dumps(bad,separators=(",", ":")).encode()
        compressed=gzip.compress(payload,mtime=1 if change=='metadata' else 0)
        if change=='trailing':compressed+=gzip.compress(b'extra',mtime=0)
        altered={**record,'bytes':len(compressed),'sha256':hashlib.sha256(compressed).hexdigest(),'raw_bytes':len(payload)}
        assert MODULE.validate_binary_asset(record['path'],compressed,altered)
    assert MODULE.validate_binary_asset('data/area-v1/8/1/3.json.gz',data,record)
    print("PRIVACY_GATE_TESTS_OK cases=16")
    return 0


if __name__ == "__main__":
    main()
    unittest.main()
