import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from patches import apply_patches
from build_storage import create_source_overlay

class PatchTests(unittest.TestCase):
    def test_order_replaces_bytecode_without_changing_originals(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, overlay, store = root / "source", root / "overlay", root / "patches"
            (source / "game").mkdir(parents=True)
            (source / "game/script.rpy").write_text("original")
            (source / "game/script.rpyc").write_text("original bytecode")
            create_source_overlay(source, overlay)
            patches, game_id = [], "a" * 32
            for index in range(2):
                package_id = f"00000000-0000-0000-0000-{index:012d}"
                files = store / game_id / package_id / "files"
                files.mkdir(parents=True)
                text = f"patch {index}".encode()
                (files / "script.rpy").write_bytes(text)
                patches.append(dict(id=package_id, name=f"Patch {index}", files=[dict(source="script.rpy", path="game/script.rpy", size=len(text), hash=hashlib.sha256(text).hexdigest())]))
            self.assertEqual(apply_patches(overlay, store, game_id, patches), ["Patch 0", "Patch 1"])
            self.assertEqual((overlay / "game/script.rpy").read_text(), "patch 1")
            self.assertFalse((overlay / "game/script.rpyc").exists())
            self.assertEqual((source / "game/script.rpy").read_text(), "original")
            self.assertEqual((source / "game/script.rpyc").read_text(), "original bytecode")
            compiled = b"compiled-only patch"
            package = store / game_id / patches[0]["id"] / "files"
            (package / "script.rpyc").write_bytes(compiled)
            compiled_patch = dict(id=patches[0]["id"], files=[dict(source="script.rpyc", path="game/script.rpyc", size=len(compiled), hash=hashlib.sha256(compiled).hexdigest())])
            apply_patches(overlay, store, game_id, [compiled_patch])
            self.assertFalse((overlay / "game/script.rpy").exists())
            self.assertEqual((source / "game/script.rpy").read_text(), "original")
            patches[0]["files"][0]["hash"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "checksum"):
                apply_patches(overlay, store, game_id, patches)
            patches[0]["files"][0]["path"] = "game/../../escape.rpy"
            with self.assertRaisesRegex(ValueError, "path"):
                apply_patches(overlay, store, game_id, patches)
    def test_empty_snapshot_and_reserved_destinations(self):
        self.assertEqual(apply_patches("unused", "unused", "old-fixture-id", []), [])
        patch = dict(id="00000000-0000-0000-0000-000000000000", files=[dict(source="source", path="game/_vnm_lazy_saves.rpy")])
        with self.assertRaisesRegex(ValueError, "Reserved"):
            apply_patches("unused", "unused", "a" * 32, [patch])


class PatchQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_patch_snapshot_survives_restart_and_caller_changes(self):
        import asyncio
        from build_queue import BuildQueue
        class Worker:
            def __init__(self, root):
                self.web_builds_path = root
                self.publishing_jobs = set()
                self.received = None
            async def build_game(self, **kwargs):
                self.received = kwargs["patches"]
                return {}
        with tempfile.TemporaryDirectory() as directory:
            worker = Worker(Path(directory))
            queue = BuildQueue(worker, max_concurrent=0)
            snapshot = [dict(id="00000000-0000-0000-0000-000000000000", files=[dict(hash="original")])]
            await queue.add("snapshot", "game", "/games/fixture", patches=snapshot)
            snapshot[0]["files"][0]["hash"] = "changed by caller"
            self.assertEqual(queue.get_record("snapshot")["patches"][0]["files"][0]["hash"], "original")
            with self.assertRaisesRegex(ValueError, "different inputs"):
                await queue.add("snapshot", "game", "/games/fixture", patches=snapshot)
            await queue.stop()
            restarted = BuildQueue(worker)
            await restarted.start()
            try:
                for _ in range(200):
                    if restarted.get_status("snapshot") == "done":
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(restarted.get_status("snapshot"), "done")
                self.assertEqual(worker.received[0]["files"][0]["hash"], "original")
            finally:
                await restarted.stop()
