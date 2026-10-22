"""Inspect patch ZIPs without executing scripts; extract only bounded regular files."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile

MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 10000

def safe_name(name):
    if (not name or len(name) > 500 or "\\" in name or re.search(r"[\x00-\x1f:]", name)
            or name.startswith("/") or any(p in ("", ".", "..") for p in name.split("/"))):
        raise ValueError("Unsafe package path: " + name)
    return name

def unpack(archive, destination, filename):
    destination = Path(destination)
    files, seen, total = [], set(), 0
    spellings, directories = {}, set()
    def write(name, stream, declared):
        nonlocal total
        safe_name(name)
        parts = name.split("/")
        for index in range(1, len(parts) + 1):
            prefix = "/".join(parts[:index])
            if spellings.setdefault(prefix.casefold(), prefix) != prefix:
                raise ValueError("Case-colliding package path: " + name)
        folded = name.casefold()
        parents = ["/".join(parts[:index]).casefold() for index in range(1, len(parts))]
        if folded in seen or folded in directories or any(parent in seen for parent in parents):
            raise ValueError("Duplicate or conflicting package path: " + name)
        seen.add(folded)
        directories.update(parents)
        if len(seen) > MAX_FILES or declared < 0 or total + declared > MAX_BYTES:
            raise ValueError("Patch exceeds 512 MiB extracted or 10,000 files.")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        size, digest = 0, hashlib.sha256()
        with target.open("xb") as output:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                total += len(chunk)
                if total > MAX_BYTES or size > declared:
                    raise ValueError("Patch exceeds its declared size or extraction limit.")
                digest.update(chunk)
                output.write(chunk)
        if size != declared:
            raise ValueError("Incomplete package file: " + name)
        files.append(dict(source=name, size=size, hash=digest.hexdigest()))
    if filename.lower().endswith(".rpy"):
        with open(archive, "rb") as stream:
            write(filename, stream, os.path.getsize(archive))
    else:
        with zipfile.ZipFile(archive) as package:
            if len(package.infolist()) > MAX_FILES:
                raise ValueError("Patch exceeds 10,000 archive entries.")
            for entry in package.infolist():
                safe_name(entry.filename.rstrip("/"))
                mode = entry.external_attr >> 16
                if entry.flag_bits & 1 or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    raise ValueError("Encrypted files, links and special files are unsupported.")
                if entry.is_dir():
                    continue
                with package.open(entry) as stream:
                    write(entry.filename, stream, entry.file_size)
    if not files:
        raise ValueError("The patch package is empty.")
    return files

if __name__ == "__main__":
    try:
        print(json.dumps(unpack(*sys.argv[1:4])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
