"""Loading-only scheduling for the exact researched Ren'Py web runtime."""
import hashlib
from pathlib import Path

FINGERPRINTS = {
    'renpy.js': '1d1dd6c49a2c31499f2288806162a2de981c2a183186acf3ca2be0f1be7658cd',
    'renpy-pre.js': 'aef6c9d0aee065bc33e19c5e0cbea4d3e1fd0d1abc08fecc30c1a2a1212c3820',
}
SLEEP = 'var _emscripten_sleep=ms=>Asyncify.handleSleep(wakeUp=>safeSetTimeout(wakeUp,ms));'
REPLACEMENT = 'var _emscripten_sleep=ms=>Asyncify.handleSleep(wakeUp=>{if(ms===0&&(window.vnmStartupLoading||window.vnmPreparingInterface))window.vnmStartupYield(()=>callUserCallback(wakeUp));else safeSetTimeout(wakeUp,ms)});'
BOOTSTRAP = '''// VNoctis: finite startup work uses message tasks, not chained timers.
window.vnmStartupSupported = true;
window.vnmStartupLoading = true;
(() => {
    const channel = new MessageChannel();
    const pending = [];
    channel.port1.onmessage = () => { const callback = pending.shift(); if (callback) callback(); };
    window.vnmStartupYield = callback => { pending.push(callback); channel.port2.postMessage(0); };
})();
'''


def publish_startup_scheduler(output_path):
    root = Path(output_path)
    sources = {}
    for name, expected in FINGERPRINTS.items():
        try:
            data = (root / name).read_bytes()
        except OSError:
            return False
        if hashlib.sha256(data).hexdigest() != expected:
            return False
        sources[name] = data.decode('utf-8')
    if sources['renpy.js'].count(SLEEP) != 1 or sources['renpy-pre.js'].count('window.presplashEnd = () => {') != 1:
        return False
    runtime = BOOTSTRAP + sources['renpy.js'].replace(SLEEP, REPLACEMENT, 1)
    pre = sources['renpy-pre.js'].replace('window.presplashEnd = () => {',
        'window.presplashEnd = () => {\n        window.vnmStartupLoading = false;', 1)
    (root / 'renpy.js').write_text(runtime, encoding='utf-8', newline='')
    (root / 'renpy-pre.js').write_text(pre, encoding='utf-8', newline='')
    return True
