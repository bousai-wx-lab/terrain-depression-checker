#!/usr/bin/env python3
"""Regression checks for the release privacy gate scanners."""

from __future__ import annotations

import importlib.util
from copy import deepcopy
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("privacy_gate.py")
SPEC = importlib.util.spec_from_file_location("release_privacy_gate", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise SystemExit("privacy gate module could not be loaded")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


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
    print("PRIVACY_GATE_TESTS_OK cases=9")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
