# audio-rooms A2 RECONCILIATION -- coordinator brief (the LAST session; read before dispatch)

Goal of A2: ship the A1-proven demo. Turn the headless proof (census/heal/fail-closed/
teardown, 21 node tests, committed) into a demo that (1) actually LOADS live on the single-
repo Pages host, (2) is gated in the ROOT CI, and (3) has an honest, version-coherent README.
A1 is the value; A2 is the shipping wrapper. This is the final audio-rooms session.

## STATE AT DISPATCH (verified live 2026-09-02)
- A1 is COMMITTED. `diEcosystem/audio-rooms/` tree is clean: kernel.js (the makeEngine seam),
  package.json (private, current pins), tracked package-lock.json, .gitignore, plans/, and
  test/ (01-census, 02-heal, 03-failclosed, 04-teardown-order, 05-boundary + helpers). 21
  tests, `npm test` green. See [[audio-rooms-a1-session25]].
- Two STRUCTURAL findings below REDIRECT the plan doc's T5/T6. Honor these over the plan doc.

## DE-RISK FIRST (do BEFORE writing anything -- the two findings that reshape A2)

### D1 -- the LIVE demo's module imports are BROKEN on Pages (the headline fix)
`index.html` import map uses LOCAL RELATIVE PATHS: `"@zakkster/lite-audio":
"../../../LiteAudio/Audio.js"` (14 entries, lines 13-27). From
`/lite-di-container/diEcosystem/audio-rooms/`, `../../../` climbs ABOVE the repo root to
`peshovurtoleta.github.io/`, where the suite siblings (LiteAudio, LiteSignal, ...) do NOT
exist on the single-repo Pages deploy. So the live demo 404s every module. It only works
LOCALLY because the siblings sit at `../` on disk. market-map already solved this by loading
from **esm.sh versioned** URLs (self-contained). **VERIFY:** open the live audio-rooms URL in
the browser pane and confirm the console shows module 404s / a blank canvas. Then the fix is
T5 below (port the import map to esm.sh).

### D2 -- the esm.sh DUAL-INSTANCE trap (market-map S10 lesson, MUST pre-empt)
Both `lite-di-signal` AND `lite-audio` (and lite-audio-pool) transitively depend on
`lite-signal`. If esm.sh resolves TWO different lite-signal module instances, reactivity
silently breaks (a signal tracked in one instance is invisible to the other). market-map
fixes this by pinning `?deps=@zakkster/lite-signal@1.5.0` on every consumer so esm.sh hands
back ONE shared instance (see market-map index.html line 13 note). The port MUST carry the
same `?deps` pin on lite-di-signal, lite-audio, lite-audio-pool, and any other lite-signal
consumer. VERIFY in the browser after the port: `import` two of them and assert the same
lite-signal module identity (or just confirm the demo's reactive room aggregates update live).

### D3 -- esm.sh browser-resolution of the AUDIO specifiers
A1 proved all 14 specifiers import from npm in NODE. esm.sh serves from npm, and market-map
already loads the overlapping di-* set from esm.sh live -- so those are known-good. The
AUDIO-specific two (`lite-audio@2.5.1`, `lite-audio-pool@1.4.0`) are NOT in market-map's map;
VERIFY they resolve + import in the BROWSER from esm.sh before trusting the port. Also
`lite-gl@2.0.0` + `lite-gl/backend` (market-map loads lite-gl; confirm the `/backend` subpath
resolves on esm.sh).

## DE-RISK RESULTS (VERIFIED LIVE IN THE BROWSER 2026-09-02 -- do not re-derive)
- **D1 CONFIRMED BROKEN:** the live Pages demo throws 12 module 404s (the relative-path map
  climbs above the repo root). Fix = the esm.sh port (T5).
- **D3 CONFIRMED:** all esm.sh specifiers resolve 200 with `application/javascript`:
  lite-audio@2.5.1, lite-audio-pool@1.4.0, lite-gl@2.0.0, lite-gl@2.0.0/backend,
  lite-signal@1.5.0 (the di-* set is already proven live by market-map).
- **D2 RESOLVED (better than feared):** `lite-di-signal@1.0.0` is DUCK-TYPED -- it imports
  NOTHING from lite-signal; the app passes lite-signal's `createRegistry` in via
  `options.createRegistry`. So the SINGLE authoritative lite-signal on the registry path is
  the app's own map entry (`@zakkster/lite-signal@1.5.0`). The only other consumer is
  lite-audio's internal reactive core. Pin `?deps=@zakkster/lite-signal@1.5.0` on lite-audio
  + lite-audio-pool for parity/insurance (esm.sh honors it -- verified the deep build points
  at `.../lite-signal@1.5.0/es2022/lite-signal.mjs`); lite-di-signal needs NO ?deps.

### VERIFIED import-map recipe for T5 (esm.sh, exact)
```
"@zakkster/lite-di-container":  "https://esm.sh/@zakkster/lite-di-container@2.2.0",
"@zakkster/lite-di-event-bus":  "https://esm.sh/@zakkster/lite-di-event-bus@1.1.0",
"@zakkster/lite-di-signal":     "https://esm.sh/@zakkster/lite-di-signal@1.0.0",
"@zakkster/lite-di-ticker":     "https://esm.sh/@zakkster/lite-di-ticker@1.0.0",
"@zakkster/lite-di-strategies": "https://esm.sh/@zakkster/lite-di-strategies@1.0.0",
"@zakkster/lite-di-supervisor": "https://esm.sh/@zakkster/lite-di-supervisor@1.0.0",
"@zakkster/lite-di-health":     "https://esm.sh/@zakkster/lite-di-health@1.0.0",
"@zakkster/lite-di-graph":      "https://esm.sh/@zakkster/lite-di-graph@1.0.0",
"@zakkster/lite-di-cron":       "https://esm.sh/@zakkster/lite-di-cron@1.0.0",
"@zakkster/lite-audio":         "https://esm.sh/@zakkster/lite-audio@2.5.1?deps=@zakkster/lite-signal@1.5.0",
"@zakkster/lite-audio-pool":    "https://esm.sh/@zakkster/lite-audio-pool@1.4.0?deps=@zakkster/lite-signal@1.5.0",
"@zakkster/lite-signal":        "https://esm.sh/@zakkster/lite-signal@1.5.0",
"@zakkster/lite-raf":           "https://esm.sh/@zakkster/lite-raf@1.2.0",
"@zakkster/lite-gl":            "https://esm.sh/@zakkster/lite-gl@2.0.0",
"@zakkster/lite-gl/backend":    "https://esm.sh/@zakkster/lite-gl@2.0.0/backend"
```
(Keep the map's existing comment header accurate: it is now CDN-absolute, host-independent --
so it loads identically local or on Pages. Delete the stale "../../../ reaches the suite root"
note.) The COORDINATOR browser-verifies the live paint against real esm.sh by serving the dir
locally (esm.sh is absolute-URL, so a local static host proves the Pages behavior); the coder
cannot (no browser tool) -- coder proves `npm test` + `npm ci` + ASCII only.

## THE TASKS

### T5 -- port the browser import map to esm.sh versioned (the real fix; makes the live demo load)
Rewrite `index.html`'s import map from relative paths to esm.sh versioned URLs, pins EXACTLY
matching `package.json` (the node-proven source of truth):
`lite-di-container@2.2.0, lite-di-event-bus@1.1.0, lite-di-signal@1.0.0, lite-di-ticker@1.0.0,
lite-di-strategies@1.0.0, lite-di-supervisor@1.0.0, lite-di-health@1.0.0, lite-di-graph@1.0.0,
lite-di-cron@1.0.0, lite-audio@2.5.1, lite-audio-pool@1.4.0, lite-signal@1.5.0, lite-raf@1.2.0,
lite-gl@2.0.0` (+ `lite-gl/backend`). Carry `?deps=@zakkster/lite-signal@1.5.0` on every
lite-signal consumer (D2). This makes ONE reconciled version set span browser + node + README.
NON-NEGOTIABLE: after the port, load the demo in the browser pane and confirm it PAINTS a room
+ the console is clean (no 404, no dual-instance breakage). The relative-path map was never
live-correct; do not preserve it.

### T6 -- extend the ROOT ci.yml with an audio-rooms job (NOT a new file)
CI is a SINGLE root workflow: `.github/workflows/ci.yml` (currently market-map only). GitHub
runs workflows ONLY from the repo-root `.github/workflows/`; a per-demo file in a subdir will
never run. ADD jobs mirroring market-map's shape, scoped to `diEcosystem/audio-rooms/`:
- a `test` matrix (node 20/22/24) running `npm ci` + `npm test` in the audio-rooms dir;
- a `break-gate` job that arms the census canary (the no-op-destroy BREAK from G1) and asserts
  the suite exits NON-ZERO -- an inverted gate (green means the canary correctly reds). Reuse
  the market-map break-gate mechanism (an env flag the harness reads, e.g. `AR_BREAK=1`); the
  A1 mock already has `breakDestroy`/`reuse` canary arms -- wire ONE of them to an env flag if
  not already, and confirm `npm test` reds under it.
- gate `npm ci` on the committed lockfile (the market-map CI-lockfile lesson -- already tracked).
Path-filter the audio-rooms jobs (`paths: diEcosystem/audio-rooms/**`) so market-map edits do
not spuriously run them and vice-versa. Do NOT touch the Pages deploy job (suite-level, already
deploys the whole tree).

### T7 -- README reconciliation + "proven headless" section + live URL
- Fix the STALE version rows (README currently drifts from package.json): line 47
  `lite-signal 1.4.4 -> 1.5.0`, line 48 `lite-raf 1.1.0 -> 1.2.0`, line 49 `lite-gl 1.5.0 ->
  2.0.0`. After T5 the table must mirror the import map KEY-FOR-KEY.
- Add a "Proven headless" section: the census gate as the receipt (21 node tests; census->0
  on leave, self-heal identity, fail-closed parent, reverse-topo teardown), HONEST about the
  fidelity boundary (mock engine + census MODEL, NOT real AudioNode disconnection -- the same
  boundary as market-map's fake socket; README lines 100-101 already state the census-is-
  modeled caveat, cross-reference it). Do NOT overclaim real Web-Audio teardown.
- Fix the live URL to `https://peshovurtoleta.github.io/lite-di-container/diEcosystem/audio-
  rooms/` (the actual Pages host; NOT zakkster.github.io/LiteDiContainer -- the market-map
  URL-mismatch finding).

### T8 -- ecosystem cross-link (cheap, optional)
Add audio-rooms beside market-map on `diEcosystem/index.html` -- a second card / one line:
"the scoped-teardown-over-Web-Audio sibling, proven headless." Reuse the existing section CSS
(no new script, no inline styles except custom props -- demo CSS law).

## A2 ASSERTIONS (each must be able to go RED)
1. LIVE: the demo at the Pages URL PAINTS a room with a clean console (0 module 404s, no
   dual-instance breakage). RED before T5 (D1), green after. This is the whole point of A2.
2. `npm ci` succeeds from the committed lockfile; every esm.sh specifier resolves in the
   browser (D3).
3. CI: audio-rooms test matrix green on node 20/22/24; break-gate job green (its armed canary
   exits NON-ZERO -- an inverted gate that reds if the canary ever stops biting).
4. README version table mirrors the import map key-for-key (a stale row is a diff-visible RED);
   the live URL returns 200.
5. NO dual lite-signal instance in the browser after the `?deps` pin (D2).

## HOUSE LAW
Do NOT git commit -- hand back the uncommitted set + a ready commit command. ASCII-only source
(U+00D7, U+00B5 excepted). No vacuous gate: the break-gate must genuinely red under its canary;
the "live demo paints" assertion must be BROWSER-VERIFIED, not asserted in prose (own the
verification at coordinator level -- a subagent cannot launder browser numbers; the market-map
S5 injected-message lesson). No dead code. demo/ never in files[] (n/a -- private pkg).

## OUT OF SCOPE (never)
GPU/observability (S4/S5) and the reactive-VM/watchlist/labeled-graph plane (S8-S10) -- no
per-voice reactive by design. A real create*-factory census counter (README's owner-elective
"real census" seam) stays owner-elective. Publishing audio-rooms to npm (it stays private).

## PIPELINE ROUTING + EFFORT
Mostly config/docs + one browser-verified port. T5 (import-map port) + T6 (CI job) carry the
only real risk (esm.sh resolution + dual-instance + inverted break-gate) -> run through the
pipeline: this brief -> coder (T5/T6, browser-verify the live paint + `?deps` singleton) ->
reviewer (audit the break-gate is non-vacuous + the `?deps` pins are complete) -> qa (confirm
CI shape + the 5 assertions, browser-verify assertion 1). T7/T8 are docs -- fold into the coder
pass or do directly (docs-only = no torture/alloc surface, self-verified by grep + a live 200).
One focused session. If D1 turns out already-fixed (the deploy somehow includes siblings), A2
collapses to T7/T8 docs -- but D1 says it 404s; verify first.
