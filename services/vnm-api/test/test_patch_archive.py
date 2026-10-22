import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile
spec = importlib.util.spec_from_file_location("patch_archive", Path(__file__).resolve().parents[1] / "src/services/patch_archive.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PatchArchiveTests(unittest.TestCase):
    def check_archive(self, entries):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "patch.zip"
            with zipfile.ZipFile(archive, "w") as package:
                for name, content in entries:
                    package.writestr(name, content)
            return module.unpack(archive, root / "files", "patch.zip")
    def test_nested_files_preserve_bytes_and_hashes(self):
        files = self.check_archive([("Wrapper/Instructions.txt", "Install"), ("Wrapper/game/mod.rpy", "init python:\n    value = 1"), ("Wrapper/game/images/icon.png", b"binary")])
        self.assertEqual(len(files), 3)
        self.assertEqual(files[-1]["size"], 6)
        self.assertEqual(len(files[-1]["hash"]), 64)
    def test_rejects_traversal_absolute_links_and_case_collisions(self):
        for path in ("../escape.rpy", "/escape.rpy", "C:/escape.rpy", "game\\escape.rpy", "game/./bad.rpy"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Unsafe"):
                module.safe_name(path)
            if "\\" not in path:
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    self.check_archive([(path, "bad")])
        with self.assertRaisesRegex(ValueError, "Case-colliding"):
            self.check_archive([("game/Test/a.rpy", "a"), ("game/test/b.rpy", "b")])
        link = zipfile.ZipInfo("game/link.rpy")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(ValueError, "links"):
            self.check_archive([(link, "../../outside")])
    def test_limits_duplicates_and_empty_archives(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.check_archive([("mod.rpy", "a"), ("mod.rpy", "b")])
        with self.assertRaisesRegex(ValueError, "empty"):
            self.check_archive([])
        original = module.MAX_BYTES
        module.MAX_BYTES = 4
        try:
            with self.assertRaisesRegex(ValueError, "512 MiB"):
                self.check_archive([("mod.rpy", "12345")])
        finally:
            module.MAX_BYTES = original

if __name__ == "__main__": unittest.main()
