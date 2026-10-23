"""Generated into a private module; no game store or native runtime changes."""
import time
import renpy


def install():
    if not renpy.emscripten or tuple(renpy.version_tuple[:4]) != (8, 5, 2, 26010301):
        return
    import emscripten
    screen = renpy.display.screen
    state = {'last': 0.0, 'done': 0, 'total': 0}

    def checkpoint():
        state['done'] += 1
        now = time.perf_counter()
        if now - state['last'] < 0.035:
            return
        state['last'] = now
        renpy.display.presplash.progress('Preparing interface...', state['done'], state['total'])

    screen._vnm_startup_checkpoint = checkpoint
    exec(_replacement, screen.__dict__)
    prepared = screen._vnm_prepare_screens

    def prepare():
        if screen.prepared:
            return prepared()
        state.update(last=time.perf_counter(), done=0,
                     total=sum(s.ast is not None for s in screen.sorted_variants()))
        emscripten.run_script('window.vnmPreparingInterface=true;Module.print("");Module.print(' + repr('Preparing interface...') + ');progress(0,' + str(max(1, state['total'])) + ');')
        try:
            return prepared()
        finally:
            # Use the existing loader panel, including the pass after presplashEnd.
            emscripten.run_script('''window.vnmPreparingInterface=false; if (!document.getElementById("presplash")) {
                const panel = document.getElementById("statusDiv");
                if (panel && !panel.classList.contains("has-error")) {
                    panel.classList.remove("visible"); panel.classList.add("hidden");
                }
            }''')

    screen.prepare_screens = prepare

    # The SDK Cython rebuild frame cannot be suspended by this WASM build.
    # Keep its exact operation order, with screen preparation called from Python.
    def rebuild(prepare_screens=True):
        renpy.style.build_styles()
        screen.prepared = False
        if prepare_screens and not renpy.game.context().init_phase:
            screen.prepare_screens()
        renpy.exports.restart_interaction()

    renpy.style.rebuild = rebuild
