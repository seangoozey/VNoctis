"""Apply an immutable, ordered patch snapshot to an owned build overlay."""
import hashlib
from pathlib import Path, PurePosixPath
import re
import shutil

def relative_path(value):
    if not isinstance(value, str) or not value or "\\" in value or re.search(r"[\x00-\x1f:]", value) or value.startswith("/") or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError("Invalid patch file path")
    return value

def apply_patches(overlay_path, storage_path, game_id, patches):
    if not patches:
        return []
    if not re.fullmatch(r"[a-f0-9]{32}", game_id):
        raise ValueError("Invalid patch game ID")
    overlay = Path(overlay_path).resolve()
    root = Path(storage_path) / game_id
    applied = []
    for patch in patches:
        if not re.fullmatch(r"[a-f0-9-]{36}", patch["id"]):
            raise ValueError("Invalid patch package ID")
        package = (root / patch["id"] / "files").resolve()
        for file in patch["files"]:
            source = package / relative_path(file["source"])
            destination = overlay / relative_path(file["path"])
            if not file["path"].startswith("game/") or any(p.startswith(".") or p.lower().startswith("_vnm") or p.lower() in ("saves", "cache", "tokens", "renpy", "lib", "__pycache__") for p in PurePosixPath(file["path"]).parts):
                raise ValueError("Reserved patch destination")
            # Parent directories must never lead back into original game data.
            if not destination.parent.resolve().is_relative_to(overlay):
                raise ValueError("Patch destination leaves build overlay")
            if not source.resolve().is_relative_to(package) or source.is_symlink():
                raise ValueError("Patch source leaves package")
            if source.stat().st_size != file["size"]:
                raise ValueError("Patch file size changed: " + file["path"])
            with source.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != file["hash"]:
                raise ValueError("Patch file checksum changed: " + file["path"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.is_symlink() or destination.is_file():
                destination.unlink()
            shutil.copyfile(source, destination)
            if destination.suffix.lower() in (".rpy", ".rpym"):
                destination.with_name(destination.name + "c").unlink(missing_ok=True)
            elif destination.suffix.lower() in (".rpyc", ".rpymc"):
                destination.with_name(destination.name[:-1]).unlink(missing_ok=True)
        applied.append(patch.get("name", patch["id"]))
    return applied
