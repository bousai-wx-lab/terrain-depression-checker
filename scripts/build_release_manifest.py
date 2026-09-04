#!/usr/bin/env python3
"""Build the deterministic file inventory used by the release privacy gate."""

from __future__ import annotations

import hashlib
import json
import mimetypes
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST_PATH = ROOT / "release-allowlist.json"
MANIFEST_PATH = ROOT / "release-manifest.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    allowlist = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    records = []
    for relative in sorted(allowlist["allowed_files"]):
        if relative == MANIFEST_PATH.name:
            continue
        path = ROOT / relative
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"manifest source is missing or not a regular file: {relative}")
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        records.append(
            {
                "path": relative,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
                "mime_type": mime_type,
            }
        )

    manifest = {
        "schema_version": 1,
        "tool_slug": allowlist["tool_slug"],
        "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "files": records,
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"RELEASE_MANIFEST_BUILT files={len(records)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

