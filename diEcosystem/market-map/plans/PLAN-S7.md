# Session 7 -- Docs, positioning, launch

## 1. SPEC

**Goal.** Session 7 (ROADMAP-DEMO.md:253-276) turns `market-map` from a documented skeleton into a product page: README rewritten as a 30-second pitch, `WHY-market-map.md` + `REJECTED.md` for the skeptical read, cross-links from the container README's Ecosystem section, and a launch write-up. No demo code changes -- docs only, plus one asset.

**Acceptance gate.** A senior JS engineer given only the live URL and `README.md`, with no verbal narration, can state unaided: (i) what `@zakkster/lite-di-container` is (explicit registration, boot validation, reverse-topo teardown, post-boot rebind), (ii) which of its features the demo exercises on screen, and (iii) why the perf/provenance numbers are believable. Secondary gate: nothing in the shipped docs contains a local absolute path (current README.md:13 and :20 both violate this) or a non-ASCII glyph.

## 2. TASKS

Ordered, atomic. All paths relative to `/Users/zakkster/Work/Portfolio/LiteLibrariesSuite/LiteDiContainer/`.

**T1 -- Capture the hero asset.** `diEcosystem/market-map/assets/kill-feed.gif`. Content: 5 s loop of the S3 kill-feed heal -- click `Kill feed`, log shows `fault -> restart -> fresh socket`, `restarts` counter increments, the viz never blanks. Width <= 900 CSS px, <= 3 MB, 12-15 fps. Referenced from README with a **relative** path only (`./assets/kill-feed.gif`); confirm the S1 Pages job publishes `assets/` (the deploy publishes the `diEcosystem/` subtree, ROADMAP-DEMO.md:104-105).

**T2 -- Rewrite `diEcosystem/market-map/README.md`** (replaces all 77 lines). Spine, in this order, adapted from the LiteSepforge blueprint to a demo (no npm badges, no API reference -- this is not a package; there is no `package.json` in the demo dir, so the house `files[]` rule is N/A and Pages publication replaces it):

1. Title + one-line blockquote tagline (`A self-healing, zero-GC market-data kernel that runs in the browser -- 15 zero-dependency single-file ESM packages, no bundler.`).
2. **Line 1 of the body: the live Pages link**, before any prose, followed immediately by the hero GIF from T1 with an alt text naming the heal.
3. Badges: CI green (S6), Pages deploy, MIT.
4. "The demo the ecosystem was missing" positioning H2 -- one paragraph on why an in-browser DI kernel is the honest test.
5. TOC.
6. **What is on screen** -- the S3 flagship buttons (`scope()` tabs, `Swap renderer build` -> rebind, `Shutdown kernel`) one bullet each, with the exact log line each emits.
7. **Architecture** -- the mermaid from T3.
8. **The packages** -- the table currently at README.md:32-46, one row per import-map entry, plus a new **Version** column carrying the S1 exact pins.
9. **Measured** -- the S5 perf table.
10. **Data provenance** -- replaces "Honest caveats" (README.md:71-77): one row per source (`binance` / `local feed-server` / `sim://random-walk`) x one column per layer (transport, top-of-book, ladder, tape), each cell `real` or `synthetic`.
11. **Run it** -- live URL, then the two local modes, **no absolute paths** (fixes README.md:13, :20).
12. **Try it yourself** -- burst stress, the three `lite-di-graph` exports, the Perfetto hint (ROADMAP-DEMO.md:211-213).
13. Testing (S6 counts + break control), What this is not, Why + Rejected links, Ecosystem, License.

**T3 -- The mermaid** (inside T2 section 7). `graph LR`, validated before commit. Spine: `FEED[lite-ws feed] --> RING[lite-ring-buffer] --> BUS[lite-di-event-bus]`; `BUS` fans to `BOOK[OrderBook]`, `TAPE[trade tape]`, `AGG[aggregates -> lite-di-signal]`; those three into `STRAT[lite-di-strategies]` into `REND[renderer: coarse / detailed / lite-gl GPU]`; `TICK[lite-di-ticker]` drives `REND`. Side subgraph `resilience`: `SUP[lite-di-supervisor]` dashed to `FEED`, `HEALTH[lite-di-health]` dashed to `SUP`, `CRON` dashed to `AGG`. All wrapped in an outer note that every node is a container binding. Escape arrows inside labels as `-&gt;` (the container README does this at README.md:445, :492). ASCII only -- no Unicode arrows.

**T4 -- Create `diEcosystem/market-map/WHY-market-map.md`.** Per LiteLeak/WHY-1.0.md convention: audience line, then H2 per decision. Sections: (a) why the firehose lands in a ring, not signals; (b) why the browser and not a Node service (a browser has no forgiving GC budget -- 16.6 ms or a dropped frame); (c) why no bundler (proves the single-file-ESM law end to end); (d) headless seams as DI applied to the DI demo (S6, ROADMAP-DEMO.md:229-231); (e) provenance honesty as a feature; (f) what this is deliberately not (not a trading system); (g) lifespan-of-these-decisions closer.

**T5 -- Create `diEcosystem/market-map/REJECTED.md`.** Format per LiteLeak/REJECTED.md: **Design / Rejected because / Chosen instead**. Seed:
1. **One signal per tick.** Rejected: allocates per tick, defeats the pitch. Chosen: ring + a handful of aggregate signals (README.md:53-57).
2. **Hot-swap via `strategies`.** Rejected: strategies is a read-path *selector* over pre-registered bindings; post-boot replacement is `container.rebind` (GAP-3). Chosen: `strategies` for zoom tiers, `rebind` for the swap button (README.md:58-60).
3. **Playwright / browser E2E.** Rejected: house law is `node:test` only, zero test deps. Chosen: headless `bootKernel` seams + the leak gate + a manual soak protocol, documented as a stated coverage limit.
4. **GPU upload reading the ring's backing store directly.** Record whichever side S4's measurement rejected (ROADMAP-DEMO.md:182-185); cite the measured `copyTo` cost at RING=65536.
5. **Renaming the demo** (ROADMAP-DEMO.md:77-79) -- deferred while it lives under `diEcosystem/`.
6. **Replay scrubbing / second exchange / in-browser SPP** (ROADMAP-DEMO.md:281-289) -- deferred, one line each.

**T6 -- Create `diEcosystem/market-map/LAUNCH.md`.** Three variants of one write-up, all ASCII: HN Show title + 150-word body; r/javascript post (leads with the GIF, closes with the Perfetto trace download); a 3-sentence version for the js-reactivity-benchmark / Andrii channel. Each carries the live URL and the one-line claim.

**T7 -- Cross-link the container README.** In the Ecosystem section, add a "Seen in production shape" subsection after README.md:432: live demo URL first, source folder second (today only `diEcosystem/index.html` is linked, source-only). Also correct the stale sibling-version sentence at README.md:549-551 (says `1.0.0-alpha.1`; siblings were bumped to `1.0.0`) so the demo's pinned table and the container README agree.

**T8 -- Repo metadata.** GitHub repo description + topics: add the live demo URL to the About link, topics `dependency-injection`, `zero-gc`, `esm`, `webgl2`, `market-data`, `no-bundler`.

**T9 -- Verify.** Run the ASCII grep, the mermaid validation, and a link check across all four new/edited docs; tick the two Part-4 DoD boxes (ROADMAP-DEMO.md:300-301).

## 3. ASSERTIONS

1. `README.md` body line 1 (first non-title, non-blockquote line) contains the live Pages URL; `grep -n '/Users/zakkster' README.md WHY-market-map.md REJECTED.md LAUNCH.md` returns **0 matches** (baseline today: 2 in README.md, lines 13 and 20).
2. Every mermaid block in `README.md` renders in GitHub preview with **0 parse errors**; arrow glyphs inside node labels appear only as `-&gt;`, never as a raw `>` or Unicode arrow.
3. The package table has exactly **15 rows** matching the 15 import-map entries at `index.html:10-24`, and every **Version** cell string-equals the pinned specifier in `index.html` after S1 (`diff` of the two sorted lists is empty). No row reads `latest` or is blank.
4. Every number in the perf table equals the S5 recorded soak figure exactly (fps, frame p99 ms, worst frame ms, long tasks > 50 ms after warm-up = **0**, ring occupancy, restarts); `grep -c 'TBD\|TODO\|XXX'` across the four docs = **0**.
5. `WHY-market-map.md` and `REJECTED.md` exist; `REJECTED.md` contains **>= 6** entries, each with all three of `**Design.**`, a rejection clause, and `**Chosen instead.**`; the four seeded rejections named in the roadmap (:263-267) are all present.
6. `LC_ALL=C grep -n '[^\x00-\x7F]' README.md WHY-market-map.md REJECTED.md LAUNCH.md` returns **0 lines**.
7. Container `README.md` Ecosystem section contains the live demo URL (**>= 1** occurrence) and no longer states siblings are at `1.0.0-alpha.1`.
8. `assets/kill-feed.gif` exists, is **<= 3 MB**, and is reachable at the deployed Pages URL (HTTP 200) after the S1 deploy job runs.

## 4. CROSS-SESSION DEPENDENCIES

- **Consumes S1**: the exact import-map pins (`index.html:10-24`, currently unpinned -- the table's Version column is unwritable until S1 lands) and the live Pages URL (the README's line-1 hook). Seam: the import map itself.
- **Consumes S3**: the kill-feed heal on the *active scope only* is the GIF's subject; the `scope()` / `rebind` / `shutdown()` log lines are quoted verbatim in README section 6. Seam: the three button handlers and their log strings.
- **Consumes S4**: the ring-upload measurement decides the direction of REJECTED entry 4. Seam: the RING size constant + the `copyTo`-vs-direct-read decision recorded in S4's rationale.
- **Consumes S5**: every number in the perf table, plus the footer soak line and the three `lite-di-graph` export buttons behind the Perfetto closer. Seam: the perf panel readout.
- **Consumes S6**: the CI badge, the test count, and the break control referenced in Testing; the headless `bootKernel({ socketFactory, glSinks, now, ctx: null })` seam is the evidence for REJECTED entry 3.
- **Terminal for Part 1-7.** Completing T1-T9 closes the last two Part-4 DoD boxes (ROADMAP-DEMO.md:300-301). Downstream: the *combined* claim (DI kernel x reactive class layer) is explicitly deferred to Session 10 (ROADMAP-DEMO.md:361-363) -- this session's README and LAUNCH.md must not pre-announce it, but both should be structured so a section and a paragraph can be appended without a rewrite.

## 5. RISKS / OPEN

- **GIF capture method -- open.** Options: macOS screen recording -> `ffmpeg` palettegen (best quality, adds a local tool step), or a browser-side capture. Risk: 3 MB is easy to blow past at 900 px; if so, fall back to an `<video muted loop autoplay playsinline>` with a static PNG poster -- but then the GitHub README (which strips video) needs the PNG, so **ship the GIF for GitHub and optionally the video on the Pages page**. Decide before T1.
- **Which repo / topics -- open.** The container README already points at `github.com/PeshoVurtoleta/lite-di-container` (README.md:429); confirm that is the repo Pages deploys from and that T8's description edit targets it, not the suite root.
- **Pin drift.** The version table is a second source of truth for `index.html`. Mitigate by generating the table from the import map in T2 and re-checking it in T9 rather than hand-typing.
- **S5 numbers are machine-specific.** Label the perf table with the capture machine, browser version, and date, or a reviewer will read unqualified figures as a claim about their hardware.
