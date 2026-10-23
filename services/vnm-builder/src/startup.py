import ast
import hashlib
from pathlib import Path
from startup_web import FINGERPRINTS

HOOK_NAME = '_vnm_startup.rpy'
SCREEN_SHA256 = '56dfe3568afc1dcba0ce48a64493ba65cff747a83d32b1ec5da26594bff964e6'


def prepare_startup(overlay_path, sdk_path):
    """Preserve the pinned screen preparation algorithm, adding bounded checkpoints."""
    hook = Path(overlay_path) / 'game' / HOOK_NAME
    if any(p.exists() or p.is_symlink() for p in (hook, hook.with_suffix('.rpyc'))):
        raise RuntimeError('Reserved startup adapter script already exists')
    try:
        source = (Path(sdk_path) / 'renpy/display/screen.py').read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        return False
    if hashlib.sha256(source.encode()).hexdigest() != SCREEN_SHA256:
        return False
    for name, expected in FINGERPRINTS.items():
        try:
            data = (Path(sdk_path) / 'web' / name).read_bytes()
        except OSError:
            return False
        if hashlib.sha256(data).hexdigest() != expected:
            return False
    function = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'prepare_screens')
    loop = next(n for n in ast.walk(function) if isinstance(n, ast.For) and ast.unparse(n.iter) == 'sorted_variants()')
    # Keep variant sorting, prediction state, ATL compilation and cycle detection intact.
    loop.body.append(ast.parse('_vnm_startup_checkpoint()').body[0])
    function.name = '_vnm_prepare_screens'
    header = []
    for line in source.splitlines():
        if line.strip() and not line.startswith('#'):
            break
        header.append(line)
    replacement = '\n'.join(header) + '\n' + ast.unparse(ast.fix_missing_locations(function))
    adapter = Path(__file__).with_name('startup_adapter.py').read_text(encoding='utf-8')
    adapter = '_replacement = ' + repr(replacement) + '\n' + adapter
    hook.parent.mkdir(parents=True, exist_ok=True)
    hook.write_text('python early:\n'
        '    import sys as _vnm_startup_sys\n    import types as _vnm_startup_types\n'
        '    _vnm_startup_module = _vnm_startup_types.ModuleType("vnm_startup_adapter")\n'
        '    _vnm_startup_sys.modules["vnm_startup_adapter"] = _vnm_startup_module\n'
        '    exec(' + repr(adapter) + ', _vnm_startup_module.__dict__)\n'
        'init -999 python:\n    __import__("sys").modules["vnm_startup_adapter"].install()\n', encoding='utf-8')
    return True
