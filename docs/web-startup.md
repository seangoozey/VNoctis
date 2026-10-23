# Browser startup responsiveness

New web builds made with the verified Ren'Py 8.5.2.26010301 runtime use cooperative
screen preparation and report **Preparing interface...** in the existing loading
panel. Screen variants, dependency order, ATL compilation, style invalidation,
and cycle checks retain the engine's behavior. Both startup preparation passes
are retained. A single expensive screen or another engine phase can still block
longer than the approximately 35 ms checkpoint budget.

The verified web runtime uses message tasks for zero-delay loading yields instead
of chaining browser timers. This lets loading advance in a hidden desktop Chrome
tab without the severe timer throttling observed in testing. Ordinary gameplay
and nonzero sleep durations keep the original scheduler; screen preparation also
uses the cooperative loading path when a language/style change rebuilds it.

This does not bypass a frozen tab or mobile OS suspension. Returning to the tab
may still be necessary for rendering and interaction to resume. No background
playback or full offline capability is implied.

## Deployment and compatibility

Rebuild the builder image, then rebuild affected games. Existing published games
do not acquire the adapter automatically. Original imported game files and the
shared SDK remain unchanged; adaptation happens in the disposable overlay and
staged web output before the offline inventory is generated.

The builder checks exact engine-source and JavaScript fingerprints. Unknown SDKs
use the standard engine. If a verified runtime unexpectedly changes during its
build, publication fails rather than combining incompatible pieces. The adapter
runs only in the researched web engine; native project initialization is unchanged.

## Validation

RMTPCFC's 24,229-screen build was profiled in Chrome alongside a synthetic Ren'Py
game. Browser checks cover interface progress, style/language rebuilds, menu
navigation, normal manual save/load, and a narrow viewport. Linux builder tests
cover ordering, repeated preparation, errors, cycle checks, native/unknown-engine
fallback, and runtime fingerprint checks. Measurements are local test evidence,
not performance guarantees for other games or devices.
