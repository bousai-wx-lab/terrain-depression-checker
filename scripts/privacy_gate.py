#!/usr/bin/env python3
"""Fail-closed privacy, release inventory, browser safety, and Git history gate."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import stat
import struct
import subprocess
import sys
import zlib
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST_PATH = ROOT / "release-allowlist.json"
MANIFEST_PATH = ROOT / "release-manifest.json"

EMAIL_PATTERN = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
URL_PATTERN = re.compile(r"https?://[^\s<>\"')`]+")
SAFE_NON_NETWORK_URLS = {
    "http://" + "www.w3.org/2000/svg",
}
LOCAL_PATH_PATTERNS = (
    re.compile(r"/U[s]ers/[^/\s]+/"),
    re.compile(r"/h[o]me/[^/\s]+/"),
    re.compile(r"/v[a]r/folders/"),
    re.compile(r"/p[r]ivate/v[a]r/folders/"),
    re.compile(r"(?i)[A-Z]:\\U[s]ers\\"),
    re.compile(r"f[i]le://"),
)
SECRET_PATTERNS = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[\"'][^\"']{8,}"),
    re.compile(r"(?i)\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~-]{12,}"),
)
OTHER_PROJECT_TERMS = (
    "Nature" + "WxLab",
    "AITry" + "Lab",
    "WxParenting" + "Diary",
    "Life" + "Plan",
    "QOLDesign" + "Lab",
    "Shared" + "DB",
)
DANGEROUS_BROWSER_TOKENS = (
    "inner" + "HTML",
    "outer" + "HTML",
    "document." + "write",
    "eval" + "(",
    "new " + "Function",
    "local" + "Storage",
    "session" + "Storage",
    "indexed" + "DB",
    "document." + "cookie",
    "navigator." + "geolocation",
    "send" + "Beacon",
    "Web" + "Socket",
)
FORBIDDEN_SUFFIXES = {
    ".bak",
    ".db",
    ".env",
    ".key",
    ".log",
    ".mov",
    ".mp4",
    ".pem",
    ".sqlite",
    ".sqlite3",
    ".zip",
}
FORBIDDEN_PARTS = {
    ".idea",
    ".vscode",
    "__pycache__",
    "coverage",
    "node_modules",
    "playwright-report",
    "private",
    "test-results",
}


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run_git(arguments: list[str], *, check: bool = True, input_bytes: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(ROOT), *arguments],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def scan_text(path_label: str, text: str, allowed_emails: set[str], allowed_hosts: set[str]) -> list[str]:
    findings: list[str] = []
    for pattern in LOCAL_PATH_PATTERNS:
        if pattern.search(text):
            findings.append(f"local path pattern: {path_label}")
            break
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            findings.append(f"secret pattern: {path_label}")
            break
    for email in EMAIL_PATTERN.findall(text):
        if email not in allowed_emails:
            findings.append(f"unapproved email: {path_label}")
    for term in OTHER_PROJECT_TERMS:
        if term.casefold() in text.casefold():
            findings.append(f"other project identifier: {path_label}")
            break
    for matched_url in URL_PATTERN.findall(text):
        url = matched_url.rstrip(".,;:")
        if url in SAFE_NON_NETWORK_URLS:
            continue
        host = (urlparse(url).hostname or "").lower()
        if host and host not in allowed_hosts:
            findings.append(f"unapproved external host {host}: {path_label}")
    suffix = Path(path_label.split("@", 1)[0]).suffix.lower()
    if suffix in {".html", ".js", ".mjs", ".svg"}:
        for token in DANGEROUS_BROWSER_TOKENS:
            if token in text:
                findings.append(f"dangerous browser API {token}: {path_label}")
    return findings


def read_text_or_none(data: bytes) -> str | None:
    if b"\x00" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def inspect_png(data: bytes) -> tuple[dict[str, int], list[str]]:
    findings: list[str] = []
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return {}, ["invalid PNG signature"]
    position = 8
    header: dict[str, int] = {}
    saw_end = False
    while position + 12 <= len(data):
        length = struct.unpack(">I", data[position:position + 4])[0]
        chunk_type = data[position + 4:position + 8]
        chunk_end = position + 12 + length
        if chunk_end > len(data):
            findings.append("truncated PNG chunk")
            break
        payload = data[position + 8:position + 8 + length]
        expected_crc = struct.unpack(">I", data[position + 8 + length:chunk_end])[0]
        actual_crc = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            findings.append("PNG chunk CRC mismatch")
        if chunk_type == b"IHDR":
            if length != 13 or header:
                findings.append("invalid PNG IHDR")
            else:
                width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
                header = {
                    "width": width,
                    "height": height,
                    "bit_depth": bit_depth,
                    "color_type": color_type,
                    "compression": compression,
                    "filtering": filtering,
                    "interlace": interlace,
                }
        if chunk_type == b"IEND":
            saw_end = True
            position = chunk_end
            break
        position = chunk_end
    if not header:
        findings.append("PNG IHDR is missing")
    if not saw_end:
        findings.append("PNG IEND is missing")
    if position != len(data):
        findings.append("PNG has trailing bytes")
    return header, findings


def validate_binary_asset(path_label: str, data: bytes, record: dict) -> list[str]:
    findings: list[str] = []
    if len(data) != record.get("bytes"):
        findings.append(f"binary asset byte count mismatch: {path_label}")
    if digest_bytes(data) != record.get("sha256"):
        findings.append(f"binary asset hash mismatch: {path_label}")
    if record.get("mime_type") == "application/gzip":
        # Only metadata-free, bounded, numeric terrain summaries are permitted.
        # Arbitrary compressed files, filenames, comments and extra members fail.
        match = re.fullmatch(r"data/(area|global)-v1/([5-9]|10)/(\d+)/(\d+)\.json\.gz", path_label)
        try:
            if not match or data[:4] != b"\x1f\x8b\x08\x00" or data[4:8] != bytes(4):
                raise ValueError("header or path")
            decoder = zlib.decompressobj(31)
            raw = decoder.decompress(data, 400001)
            if len(raw) > 400000 or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                raise ValueError("compressed bounds")
            if len(raw) != record.get("raw_bytes"):
                raise ValueError("raw byte count")
            value = json.loads(raw)
            _, z, x, y = match.groups()
            if set(value) != {"v", "z", "x", "y", "n", "e", "a"} or [value[k] for k in ("v", "z", "x", "y", "n")] != [1, int(z), int(x), int(y), 128]:
                raise ValueError("schema")
            if len(value["e"]) != 16384 or len(value["a"]) != 16384:
                raise ValueError("array length")
            for e, a in zip(value["e"], value["a"]):
                if type(e) is not int or type(a) is not int or not -500000 <= e <= 9000000 or not 0 <= a <= 1000000000 or (a == 0 and e != 0):
                    raise ValueError("numeric range")
        except (ValueError, TypeError, KeyError, zlib.error):
            findings.append(f"invalid area summary: {path_label}")
        return findings
    if record.get("mime_type") != "image/png":
        findings.append(f"unsupported binary asset MIME: {path_label}")
        return findings
    header, png_findings = inspect_png(data)
    findings.extend(f"{finding}: {path_label}" for finding in png_findings)
    for field in ("width", "height", "bit_depth", "color_type"):
        if header.get(field) != record.get(field):
            findings.append(f"binary asset {field} mismatch: {path_label}")
    if header and (header.get("compression") != 0 or header.get("filtering") != 0 or header.get("interlace") not in {0, 1}):
        findings.append(f"unsupported PNG encoding: {path_label}")
    return findings


def validate_worktree(allowlist: dict) -> list[str]:
    findings: list[str] = []
    allowed_files = set(allowlist["allowed_files"])
    allowed_emails = {item["email"] for item in allowlist["allowed_git_identities"]}
    allowed_hosts = {host.lower() for host in allowlist["allowed_external_hosts"]}
    binary_assets = {item["path"]: item for item in allowlist.get("allowed_binary_assets", [])}
    actual_files: set[str] = set()

    if len(binary_assets) != len(allowlist.get("allowed_binary_assets", [])):
        findings.append("duplicate binary asset path")
    for binary_path in binary_assets:
        if binary_path not in allowed_files:
            findings.append(f"binary asset is not in allowed_files: {binary_path}")

    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT)
        if relative.parts and relative.parts[0] == ".git":
            continue
        relative_text = relative.as_posix()
        if path.is_symlink():
            findings.append(f"symlink is prohibited: {relative_text}")
            continue
        if path.is_dir():
            if any(part in FORBIDDEN_PARTS for part in relative.parts):
                findings.append(f"forbidden directory: {relative_text}")
            continue
        actual_files.add(relative_text)
        if relative_text not in allowed_files:
            findings.append(f"file is not allowlisted: {relative_text}")
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            findings.append(f"forbidden file type: {relative_text}")
        mode = path.stat().st_mode
        if mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
            findings.append(f"unexpected executable bit: {relative_text}")
        binary_record = binary_assets.get(relative_text)
        text_limit = allowlist.get("large_text_files", {}).get(relative_text, allowlist["max_file_bytes"])
        if path.stat().st_size > int(text_limit) and binary_record is None:
            findings.append(f"file exceeds size limit: {relative_text}")
        data = path.read_bytes()
        text = read_text_or_none(data)
        if text is None:
            record = binary_record
            if record is None:
                findings.append(f"unexpected binary or non-UTF-8 file: {relative_text}")
            else:
                findings.extend(validate_binary_asset(relative_text, data, record))
        else:
            if relative_text in binary_assets:
                findings.append(f"configured binary asset is text: {relative_text}")
            findings.extend(scan_text(relative_text, text, allowed_emails, allowed_hosts))

    for missing in sorted(allowed_files - actual_files):
        findings.append(f"allowlisted file is missing: {missing}")
    return findings


def validate_manifest(allowlist: dict) -> list[str]:
    findings: list[str] = []
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"release manifest cannot be read: {error}"]
    if manifest.get("tool_slug") != allowlist.get("tool_slug"):
        findings.append("release manifest tool_slug mismatch")
    expected_paths = sorted(path for path in allowlist["allowed_files"] if path != MANIFEST_PATH.name)
    records = manifest.get("files")
    if not isinstance(records, list):
        return findings + ["release manifest files is not a list"]
    manifest_paths = [record.get("path") for record in records]
    if manifest_paths != expected_paths:
        findings.append("release manifest file set or order mismatch")
    for record in records:
        relative = record.get("path")
        if not isinstance(relative, str):
            findings.append("release manifest contains an invalid path")
            continue
        path = ROOT / relative
        if not path.is_file():
            findings.append(f"manifest file is missing: {relative}")
            continue
        data = path.read_bytes()
        if record.get("bytes") != len(data):
            findings.append(f"manifest byte count mismatch: {relative}")
        if record.get("sha256") != digest_bytes(data):
            findings.append(f"manifest hash mismatch: {relative}")
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if record.get("mime_type") != mime_type:
            findings.append(f"manifest MIME mismatch: {relative}")
    return findings


def validate_workflow(allowlist: dict) -> list[str]:
    workflow_path = ROOT / ".github/workflows/privacy-gate.yml"
    try:
        workflow = workflow_path.read_text(encoding="utf-8")
    except OSError as error:
        return [f"workflow cannot be read: {error}"]
    findings: list[str] = []
    checkout = f"actions/checkout@{allowlist['required_checkout_sha']}"
    if checkout not in workflow:
        findings.append("checkout action is not pinned to the approved commit")
    if "fetch-depth: 0" not in workflow:
        findings.append("workflow does not fetch full history")
    if "persist-credentials: false" not in workflow:
        findings.append("workflow persists Git credentials")
    if "permissions: {}" not in workflow:
        findings.append("workflow lacks default-deny permissions")
    return findings


def validate_git(allowlist: dict) -> list[str]:
    if not (ROOT / ".git").exists():
        return []
    findings: list[str] = []
    allowed_identities = {
        (item["name"], item["email"])
        for item in allowlist["allowed_git_identities"]
    }
    allowed_emails = {email for _, email in allowed_identities}
    allowed_hosts = {host.lower() for host in allowlist["allowed_external_hosts"]}
    allowed_binary_hashes = {
        item["sha256"] for item in allowlist.get("allowed_binary_assets", [])
    }
    large_text_hashes = set()
    for relative, limit in allowlist.get("large_text_files", {}).items():
        path = ROOT / relative
        if relative not in allowlist["allowed_files"] or not path.is_file() or path.stat().st_size > limit:
            findings.append(f"large text approval is invalid: {relative}")
            continue
        data = path.read_bytes()
        if read_text_or_none(data) is not None:
            large_text_hashes.add(digest_bytes(data))

    # A new release changes its manifest. Keep checking historical versions of
    # these exact approved paths, rather than accepting only today's hash.
    large_paths = sorted(set(allowlist.get("large_text_files", {})) & set(allowlist["allowed_files"]))
    if large_paths:
        historical = run_git(["rev-list", "--objects", "--all", "--", *large_paths])
        for line in historical.stdout.decode("utf-8", "strict").splitlines():
            object_id, separator, relative = line.partition(" ")
            if not separator or relative not in large_paths:
                continue
            data = run_git(["cat-file", "blob", object_id]).stdout
            if len(data) <= allowlist["large_text_files"][relative] and read_text_or_none(data) is not None:
                large_text_hashes.add(digest_bytes(data))

    names = run_git(["log", "--all", "--format=", "--name-only"], check=False).stdout.decode("utf-8", "replace")
    findings.extend(scan_text("historical-paths", names, allowed_emails, allowed_hosts))
    refs = run_git(["for-each-ref", "--format=%(refname)"], check=False).stdout.decode("utf-8", "replace")
    findings.extend(scan_text("git-refs", refs, allowed_emails, allowed_hosts))

    remote_output = run_git(["remote", "-v"]).stdout.decode("utf-8", "replace")
    allowed_remote_urls = set(allowlist.get("allowed_remote_urls", []))
    for line in remote_output.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] not in allowed_remote_urls:
            findings.append(f"unapproved Git remote: {parts[0]}")

    log = run_git(
        ["log", "--all", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00"],
        check=False,
    ).stdout
    fields = log.decode("utf-8", "replace").split("\x00")
    for index in range(0, len(fields) - 5, 6):
        commit, author_name, author_email, committer_name, committer_email, message = fields[index:index + 6]
        if commit and (author_name, author_email) not in allowed_identities:
            findings.append(f"unapproved author identity: {commit[:12]}")
        if commit and (committer_name, committer_email) not in allowed_identities:
            findings.append(f"unapproved committer identity: {commit[:12]}")
        findings.extend(scan_text(f"commit-message@{commit[:12]}", message, allowed_emails, allowed_hosts))

    object_listing = run_git(
        ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        check=False,
    ).stdout.decode("utf-8", "replace")
    for line in object_listing.splitlines():
        parts = line.split()
        if len(parts) != 3:
            findings.append("Git object inventory is unreadable")
            continue
        object_id, object_type, object_size_text = parts
        try:
            object_size = int(object_size_text)
        except ValueError:
            findings.append(f"Git object size is invalid: {object_id[:12]}")
            continue
        if object_size > int(allowlist["max_file_bytes"]):
            if object_type != "blob":
                findings.append(f"Git object exceeds size limit: {object_id[:12]}")
                continue
            oversized_data = run_git(["cat-file", "-p", object_id]).stdout
            if digest_bytes(oversized_data) in large_text_hashes:
                findings.extend(scan_text(f"large-git-object@{object_id[:12]}", oversized_data.decode("utf-8"), allowed_emails, allowed_hosts))
            elif digest_bytes(oversized_data) not in allowed_binary_hashes:
                findings.append(f"Git object exceeds size limit: {object_id[:12]}")
            continue
        if object_type not in {"blob", "commit", "tag", "tree"}:
            findings.append(f"unexpected Git object type: {object_type}")
            continue
        if object_type == "tree":
            continue
        data = run_git(["cat-file", "-p", object_id]).stdout
        text = read_text_or_none(data)
        if text is None:
            if object_type != "blob" or digest_bytes(data) not in allowed_binary_hashes:
                findings.append(f"binary or non-UTF-8 Git object: {object_id[:12]}")
        else:
            findings.extend(scan_text(f"git-object@{object_id[:12]}", text, allowed_emails, allowed_hosts))

    fsck = run_git(["fsck", "--full", "--no-reflogs", "--unreachable"], check=False)
    if fsck.returncode != 0:
        findings.append("Git fsck failed")
    return findings


def main() -> int:
    try:
        allowlist = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"PRIVACY_GATE_FAILED allowlist unreadable: {error}", file=sys.stderr)
        return 1

    findings = []
    findings.extend(validate_worktree(allowlist))
    findings.extend(validate_manifest(allowlist))
    findings.extend(validate_workflow(allowlist))
    findings.extend(validate_git(allowlist))
    findings = sorted(set(findings))
    if findings:
        print(f"PRIVACY_GATE_FAILED findings={len(findings)}", file=sys.stderr)
        for finding in findings:
            print(f"- {finding}", file=sys.stderr)
        return 1
    print(
        "PRIVACY_GATE_OK "
        f"files={len(allowlist['allowed_files'])} "
        "history=checked identity=checked external_hosts=checked browser_apis=checked"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
