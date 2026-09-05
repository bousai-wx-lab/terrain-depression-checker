#!/usr/bin/env python3
"""Build and independently verify an exact, default-deny Pages archive."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile

import privacy_gate as gate


# Preserve the existing Pages file set: only the CI definition is excluded.
EXCLUDED = frozenset({".github/workflows/privacy-gate.yml"})


def release_files(root: Path, allowlist: dict) -> dict[str, bytes]:
    names = allowlist["allowed_files"]
    if len(names) != len(set(names)) or not EXCLUDED.issubset(names):
        raise ValueError("invalid release inventory")
    files = {}
    for name in sorted(set(names) - EXCLUDED):
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or str(path) != name:
            raise ValueError("unsafe release path")
        source = root / name
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(root.resolve()):
            raise ValueError("unsafe release source")
        files[name] = source.read_bytes()
    return files


def verify_archive(archive: Path, expected: dict[str, bytes]) -> None:
    seen = set()
    with tarfile.open(archive, "r:") as bundle:
        for member in bundle:
            name = member.name
            if name in seen or name not in expected or not member.isfile():
                raise ValueError("unexpected, duplicate, or non-regular archive member")
            if member.uid or member.gid or member.uname or member.gname or member.pax_headers:
                raise ValueError("unexpected archive metadata")
            if member.mode != 0o644 or member.mtime != 0:
                raise ValueError("unexpected archive permissions or timestamp")
            payload = bundle.extractfile(member).read()
            if member.size != len(expected[name]) or payload != expected[name]:
                raise ValueError("archive bytes differ from the approved release")
            seen.add(name)
    if seen != set(expected):
        raise ValueError("archive inventory differs from the approved release")


def build_archive(destination: Path, expected: dict[str, bytes]) -> Path:
    destination.mkdir(parents=True, exist_ok=False)
    archive = destination / "artifact.tar"
    with tarfile.open(archive, "w", format=tarfile.USTAR_FORMAT) as bundle:
        for name, data in sorted(expected.items()):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            member.mtime = 0
            bundle.addfile(member, io.BytesIO(data))
    verify_archive(archive, expected)
    return archive


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    destination = args.output_dir.resolve()
    if destination.is_relative_to(gate.ROOT.resolve()):
        raise SystemExit("artifact output must be outside the public repository")
    allowlist = json.loads(gate.ALLOWLIST_PATH.read_text(encoding="utf-8"))
    findings = gate.validate_worktree(allowlist) + gate.validate_manifest(allowlist)
    if findings:
        raise SystemExit("PAGES_ARTIFACT_REJECTED: release inventory or bytes failed validation")
    expected = release_files(gate.ROOT, allowlist)
    archive = build_archive(destination, expected)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    print(f"PAGES_ARTIFACT_OK files={len(expected)} sha256={digest}")


if __name__ == "__main__":
    main()
