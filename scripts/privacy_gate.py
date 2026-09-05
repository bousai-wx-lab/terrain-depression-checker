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

EMAIL_PATTERN = re.compile(r"(?i)(?<![A-Z0-9._%+\-\[\]])[A-Z0-9._%+\-\[\]]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9-])")
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
        ["git", "--no-replace-objects", "-C", str(ROOT), *arguments],
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
            findings.append(f"unapproved external host: {path_label}")
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


def scan_path(label: str, relative: str, allowed_emails: set[str], allowed_hosts: set[str]) -> list[str]:
    """Scan the unquoted name, without putting a rejected name into public logs."""
    findings = scan_text(label, "/" + relative, allowed_emails, allowed_hosts)
    parts = relative.split("/")
    if any(not part or part in {".", ".."} or "\\" in part or any(ord(c) < 32 for c in part) for part in parts):
        findings.append(f"unsafe file name: {label}")
    if any(part.lower() in FORBIDDEN_PARTS or part.lower() == ".git" for part in parts):
        findings.append(f"forbidden directory name: {label}")
    if any(Path(part).suffix.lower() in FORBIDDEN_SUFFIXES or part.lower() == ".env" or part.lower().startswith(".env.") for part in parts):
        findings.append(f"forbidden file type: {label}")
    return findings


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
        label = f"file@{digest_bytes(relative_text.encode())[:12]}"
        name_findings = scan_path(label, relative_text, allowed_emails, allowed_hosts)
        findings.extend(name_findings)
        if name_findings or relative_text not in allowed_files:
            relative_text = label
        if path.is_symlink():
            findings.append(f"symlink is prohibited: {relative_text}")
            continue
        if path.is_dir():
            if any(part in FORBIDDEN_PARTS for part in relative.parts):
                findings.append(f"forbidden directory: {relative_text}")
            continue
        actual_files.add(relative.as_posix())
        if relative.as_posix() not in allowed_files:
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
    except (OSError, json.JSONDecodeError):
        return ["release manifest cannot be read"]
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
        if not isinstance(relative, str) or relative not in expected_paths:
            findings.append("release manifest contains an invalid path")
            continue
        path = ROOT / relative
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(ROOT.resolve()):
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
    except OSError:
        return ["workflow cannot be read"]
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


def parse_tree(data: bytes, oid_bytes: int) -> list[tuple[str, str, str]]:
    """Read raw NUL-delimited tree entries; Git's display quoting is not input."""
    entries = []
    offset = 0
    while offset < len(data):
        separator = data.index(b" ", offset)
        end = data.index(b"\x00", separator)
        mode = data[offset:separator].decode("ascii")
        name = data[separator + 1:end].decode("utf-8", "strict")
        object_id = data[end + 1:end + 1 + oid_bytes]
        if len(object_id) != oid_bytes or not name or "/" in name:
            raise ValueError("invalid tree entry")
        entries.append((mode, name, object_id.hex()))
        offset = end + 1 + oid_bytes
    if len({name for _, name, _ in entries}) != len(entries):
        raise ValueError("duplicate tree entry")
    return entries


def scan_object_identity(label: str, text: str, kind: str, allowed: set[tuple[str, str]]) -> list[str]:
    findings = []
    header, separator, _ = text.partition("\n\n")
    if not separator:
        return [f"invalid Git object header: {label}"]
    for role in (("author", "committer") if kind == "commit" else ("tagger",)):
        values = [line[len(role) + 1:] for line in header.splitlines() if line.startswith(role + " ")]
        match = re.fullmatch(r"([^<>\n]+) <([^<>\n]+)> -?\d+ [+-]\d{4}", values[0]) if len(values) == 1 else None
        if match is None or match.groups() not in allowed:
            findings.append(f"unapproved {role} identity: {label}")
    return findings


def _validate_git(allowlist: dict) -> list[str]:
    findings: list[str] = []
    allowed = {(item["name"], item["email"]) for item in allowlist["allowed_git_identities"]}
    emails = {email for _, email in allowed}
    hosts = set(allowlist["allowed_external_hosts"])
    binaries = {item["sha256"] for item in allowlist.get("allowed_binary_assets", [])}
    large_paths = allowlist.get("large_text_files", {})
    if not set(large_paths) <= set(allowlist["allowed_files"]):
        return ["large text approval contains unapproved paths"]
    if run_git(["rev-parse", "--is-shallow-repository"]).stdout.strip() != b"false":
        return ["complete Git history is required"]
    oid_bytes = {b"sha1": 20, b"sha256": 32}[run_git(["rev-parse", "--show-object-format"]).stdout.strip()]
    refs = run_git(["for-each-ref", "--format=%(refname)"]).stdout.decode("utf-8", "strict")
    findings.extend(scan_text("git-refs", refs, emails, hosts))
    if "refs/replace/" in refs:
        findings.append("Git replacement refs are prohibited")
    for line in run_git(["remote", "-v"]).stdout.decode("utf-8", "strict").splitlines():
        fields = line.split()
        if len(fields) != 3 or fields[1] not in set(allowlist.get("allowed_remote_urls", [])):
            findings.append("unapproved Git remote")

    # Enumerate reachable AND detached/otherwise unreachable objects. Every
    # inventory/read failure rejects the release, never an empty-success scan.
    inventory_args = ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"]
    inventory = run_git(inventory_args).stdout
    objects = {}
    for line in inventory.decode("ascii", "strict").splitlines():
        object_id, kind, size_text = line.split()
        size = int(size_text)
        if not re.fullmatch(r"[0-9a-f]{" + str(oid_bytes * 2) + "}", object_id) or kind not in {"blob", "tree", "commit", "tag"} or size < 0 or object_id in objects:
            raise ValueError("invalid inventory")
        objects[object_id] = (kind, size)
    if not objects or len(objects) > 100000 or sum(size for _, size in objects.values()) > 1024 * 1024 * 1024:
        return ["Git object inventory is empty or exceeds inspection bounds"]
    max_size = max([int(allowlist["max_file_bytes"]), *large_paths.values(),
                    *[item["bytes"] for item in allowlist.get("allowed_binary_assets", [])]])
    if any(size > max_size for _, size in objects.values()):
        return ["Git object exceeds inspection size limit"]

    trees = {}
    texts = {}
    binary_ids = set()
    roots = set()
    ids = list(objects)
    # Small batches avoid thousands of subprocesses and do not persist raw
    # history or rejected content in temporary files or Actions artifacts.
    for start in range(0, len(ids), 64):
        batch = ids[start:start + 64]
        output = run_git(["cat-file", "--batch"], input_bytes=("\n".join(batch) + "\n").encode()).stdout
        offset = 0
        for object_id in batch:
            kind, size = objects[object_id]
            end = output.index(b"\n", offset)
            if output[offset:end] != f"{object_id} {kind} {size}".encode():
                raise ValueError("object read mismatch")
            data = output[end + 1:end + 1 + size]
            offset = end + 1 + size
            if len(data) != size or output[offset:offset + 1] != b"\n":
                raise ValueError("truncated object")
            offset += 1
            label = f"git-object@{object_id[:12]}"
            if kind == "tree":
                trees[object_id] = parse_tree(data, oid_bytes)
                for mode, name, child in trees[object_id]:
                    findings.extend(scan_path(label, name, emails, hosts))
                    expected = "tree" if mode == "40000" else "blob"
                    if mode not in {"40000", "100644"}:
                        findings.append(f"prohibited Git tree mode: {label}")
                    if child not in objects or objects[child][0] != expected:
                        findings.append(f"missing or invalid Git tree child: {label}")
            else:
                text = read_text_or_none(data)
                if text is None:
                    if kind != "blob" or digest_bytes(data) not in binaries:
                        findings.append(f"binary or non-UTF-8 Git object: {label}")
                    else:
                        binary_ids.add(object_id)
                else:
                    findings.extend(scan_text(label, text, emails, hosts))
                    if kind == "blob":
                        texts[object_id] = text
                    else:
                        findings.extend(scan_object_identity(label, text, kind, allowed))
                        if kind == "commit":
                            root = text.splitlines()[0].removeprefix("tree ")
                            if root not in objects or objects[root][0] != "tree":
                                findings.append(f"missing commit tree: {label}")
                            else:
                                roots.add(root)
        if offset != len(output):
            raise ValueError("unexpected object batch suffix")

    # Walk commit roots and detached trees. Recover complete, raw paths for
    # browser-API checks, nested names and exact-path large-text approvals.
    child_trees = {child for entries in trees.values() for mode, _, child in entries if mode == "40000"}
    roots.update(set(trees) - child_trees)
    pending = [(root, "") for root in roots]
    seen = set()
    blob_paths = {}
    while pending:
        tree, prefix = pending.pop()
        if (tree, prefix) in seen:
            continue
        seen.add((tree, prefix))
        if len(seen) > 200000 or prefix.count("/") > 64:
            return findings + ["Git tree traversal exceeds inspection bounds"]
        for mode, name, child in trees.get(tree, []):
            relative = prefix + name
            label = f"git-path@{digest_bytes(relative.encode())[:12]}"
            findings.extend(scan_path(label, relative, emails, hosts))
            if mode == "40000":
                pending.append((child, relative + "/"))
            else:
                blob_paths.setdefault(child, set()).add(relative)
    if set(trees) - {tree for tree, _ in seen}:
        findings.append("Git tree coverage is incomplete")
    for object_id, (kind, size) in objects.items():
        label = f"git-object@{object_id[:12]}"
        paths = blob_paths.get(object_id, set())
        if size > int(allowlist["max_file_bytes"]) and object_id not in binary_ids:
            if kind != "blob" or not paths or any(size > large_paths.get(path, 0) for path in paths):
                findings.append(f"Git object exceeds approved path size: {label}")
        if object_id in texts:
            # A standalone text blob has no trustworthy extension: apply the
            # browser checks conservatively until it has a known file path.
            suffixes = {Path(path).suffix.lower() for path in paths} if paths else {".js"}
            for suffix in suffixes & {".html", ".js", ".mjs", ".svg"}:
                findings.extend(scan_text(f"object{suffix}@{object_id[:12]}", texts[object_id], emails, hosts))
    run_git(["fsck", "--full", "--strict", "--no-reflogs"])
    if run_git(inventory_args).stdout != inventory:
        findings.append("Git object inventory changed during inspection")
    return findings


def validate_git(allowlist: dict) -> list[str]:
    try:
        return _validate_git(allowlist)
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError, KeyError, IndexError, TypeError):
        # Never echo command output, malformed identity, path or secret value.
        return ["Git inspection could not be completed; release blocked"]


def main() -> int:
    try:
        allowlist = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        print("PRIVACY_GATE_FAILED allowlist unreadable", file=sys.stderr)
        return 1

    findings = []
    try:
        findings.extend(validate_worktree(allowlist))
        findings.extend(validate_manifest(allowlist))
        findings.extend(validate_workflow(allowlist))
        findings.extend(validate_git(allowlist))
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        findings.append("release inspection could not be completed; release blocked")
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
