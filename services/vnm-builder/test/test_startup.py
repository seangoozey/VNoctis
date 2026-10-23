import ast
import hashlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import startup
import startup_web

# A small engine fixture with the same control-flow guarantees as the pinned function.
SCREEN = '''
def prepare_screens():
    global prepared
    if prepared:
        return
    predict_cache.clear()
    old_predicting = renpy.display.predict.predicting
    renpy.display.predict.predicting = True
    try:
        if not analyzed:
            analyze_screens()
        for s in sorted_variants():
            if s.ast is None:
                continue
            s.ast.unprepare_screen()
            s.ast.prepare_screen()
        renpy.atl.compile_all()
        prepared = True
    finally:
        renpy.display.predict.predicting = old_predicting
    if renpy.config.developer and use_cycle:
        raise Exception('cycle')
'''


class StartupTests(unittest.TestCase):
    def generate(self, root):
        sdk = root / 'sdk/renpy/display'
        sdk.mkdir(parents=True)
        (sdk / 'screen.py').write_text(SCREEN)
        (root / 'sdk/web').mkdir()
        for name in startup_web.FINGERPRINTS: (root / 'sdk/web' / name).write_text('trusted runtime')
        fingerprints = {name: hashlib.sha256(b'trusted runtime').hexdigest() for name in startup_web.FINGERPRINTS}
        with patch.object(startup, 'FINGERPRINTS', fingerprints), patch.object(startup, 'SCREEN_SHA256', hashlib.sha256(SCREEN.encode()).hexdigest()):
            self.assertTrue(startup.prepare_startup(root / 'overlay', root / 'sdk'))
        hook = root / 'overlay/game' / startup.HOOK_NAME
        # Read the literal exec argument; never execute imported game code.
        import textwrap
        body = ast.parse(textwrap.dedent(hook.read_text().split('python early:\n', 1)[1].split('init -999 python:', 1)[0]))
        return ast.literal_eval(body.body[-1].value.args[0])

    def test_unknown_sdk_and_reserved_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertFalse(startup.prepare_startup(root / 'overlay', root / 'unknown'))
            self.assertFalse((root / 'overlay').exists())
            self.generate(root)
            with self.assertRaisesRegex(RuntimeError, 'Reserved'):
                startup.prepare_startup(root / 'overlay', root / 'sdk')

    def test_browser_flags_avoid_renpy_private_name_mangling_and_unknown_web_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            adapter = self.generate(root)
            self.assertNotIn('window.__', adapter)
            self.assertIn('window.vnmPreparingInterface=true', adapter)
            (root / 'sdk/web/renpy.js').write_text('different runtime')
            fingerprints = {name: hashlib.sha256(b'trusted runtime').hexdigest() for name in startup_web.FINGERPRINTS}
            with patch.object(startup, 'FINGERPRINTS', fingerprints), patch.object(startup, 'SCREEN_SHA256', hashlib.sha256(SCREEN.encode()).hexdigest()):
                self.assertFalse(startup.prepare_startup(root / 'other', root / 'sdk'))
            self.assertFalse((root / 'other').exists())

    def runtime(self, adapter, *, web=True, supported=True, fail=False, cycle=False):
        calls = []
        screen = types.ModuleType('fake_screen')
        screen.prepared = False
        screen.analyzed = False
        screen.use_cycle = ['nested'] if cycle else []
        screen.predict_cache = types.SimpleNamespace(clear=lambda: calls.append('clear'))
        def analyze():
            calls.append('analyze')
            screen.analyzed = True
        screen.analyze_screens = analyze
        class AST:
            def __init__(self, name): self.name = name
            def unprepare_screen(self): calls.append('unprepare:' + self.name)
            def prepare_screen(self):
                calls.append('prepare:' + self.name)
                if fail: raise ValueError('bad screen')
        variants = [types.SimpleNamespace(ast=AST('nested')), types.SimpleNamespace(ast=None), types.SimpleNamespace(ast=AST('parent'))]
        screen.sorted_variants = lambda: variants
        native_prepare = lambda: calls.append('native')
        screen.prepare_screens = native_prepare
        context = types.SimpleNamespace(init_phase=False)
        renpy = types.SimpleNamespace(emscripten=web, version_tuple=(8, 5, 2, 26010301 if supported else 0),
            display=types.SimpleNamespace(screen=screen, predict=types.SimpleNamespace(predicting=False),
                presplash=types.SimpleNamespace(progress=lambda *args: calls.append(('progress', args)))),
            style=types.SimpleNamespace(build_styles=lambda: calls.append('styles'), rebuild=lambda: calls.append('native rebuild')),
            exports=types.SimpleNamespace(restart_interaction=lambda: calls.append('restart')),
            atl=types.SimpleNamespace(compile_all=lambda: calls.append('atl')),
            config=types.SimpleNamespace(developer=True), game=types.SimpleNamespace(context=lambda: context))
        screen.renpy = renpy
        emscripten = types.SimpleNamespace(run_script=lambda script: calls.append(('js', script)), run_script_string=lambda _: 'yes' if supported else 'no')
        clock = iter(i * .04 for i in range(100))
        with patch.dict(sys.modules, renpy=renpy, emscripten=emscripten), patch('time.perf_counter', side_effect=lambda: next(clock)):
            scope = {}
            exec(adapter, scope)
            scope['install']()
        return renpy, screen, calls, context

    def test_order_rebuild_and_init_semantics(self):
        with tempfile.TemporaryDirectory() as tmp:
            adapter = self.generate(Path(tmp))
            renpy, screen, calls, context = self.runtime(adapter)
            screen.prepare_screens()
            ordered = [c for c in calls if isinstance(c, str)]
            self.assertEqual(ordered, ['clear', 'analyze', 'unprepare:nested', 'prepare:nested', 'unprepare:parent', 'prepare:parent', 'atl'])
            self.assertTrue(screen.prepared)
            self.assertFalse(renpy.display.predict.predicting)
            before = len(calls)
            screen.prepare_screens()
            self.assertEqual(before, len(calls))
            renpy.style.rebuild()
            self.assertEqual(calls[-1], 'restart')
            self.assertEqual(calls.count('prepare:parent'), 2)
            context.init_phase = True
            renpy.style.rebuild()
            self.assertFalse(screen.prepared)
            self.assertEqual(calls.count('prepare:parent'), 2)
            self.assertEqual(calls[-1], 'restart')

    def test_exception_cleanup_and_cycle_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            adapter = self.generate(Path(tmp))
            for failure, cycle in [(True, False), (False, True)]:
                renpy, screen, calls, _ = self.runtime(adapter, fail=failure, cycle=cycle)
                with self.assertRaisesRegex(Exception, 'bad screen|cycle'):
                    screen.prepare_screens()
                self.assertFalse(renpy.display.predict.predicting)
                self.assertIn('vnmPreparingInterface=false', calls[-1][1])

    def test_native_and_unsupported_engine_do_not_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            adapter = self.generate(Path(tmp))
            for web, supported in [(False, True), (True, False)]:
                _, screen, calls, _ = self.runtime(adapter, web=web, supported=supported)
                screen.prepare_screens()
                self.assertEqual(calls, ['native'])

    def test_scheduler_is_atomic_on_mismatch_and_only_changes_zero_sleep(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sources = {'renpy.js': startup_web.SLEEP, 'renpy-pre.js': 'window.presplashEnd = () => { hide(); };'}
            fingerprints = {name: hashlib.sha256(source.encode()).hexdigest() for name, source in sources.items()}
            for name, source in sources.items(): (root / name).write_text(source)
            before = (root / 'renpy.js').read_bytes()
            self.assertFalse(startup_web.publish_startup_scheduler(root))
            self.assertEqual((root / 'renpy.js').read_bytes(), before)
            with patch.object(startup_web, 'FINGERPRINTS', fingerprints):
                self.assertTrue(startup_web.publish_startup_scheduler(root))
                self.assertIn('ms===0&&', (root / 'renpy.js').read_text())
                self.assertIn('else safeSetTimeout(wakeUp,ms)', (root / 'renpy.js').read_text())
                self.assertIn('vnmStartupLoading = false', (root / 'renpy-pre.js').read_text())
                self.assertFalse(startup_web.publish_startup_scheduler(root))


if __name__ == '__main__': unittest.main()
