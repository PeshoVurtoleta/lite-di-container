# 0004 -- Signal/reactive packaging: where DISignal and DIReactive live

- Status: accepted
- Session: D7 (decision only -- no code; X1 implements)
- Findings: D-06, D-20
- Date: 2026-08-09

## Context

`2.0.0/DISignal.js` and `2.0.0/DIReactive.js` were carried into the v2 proposal
as a reactive-DI layer over `@zakkster/lite-signal`. As found in the D-06 review
they are incoherent about their own identity: `DISignal.js` and `DIReactive.js`
name themselves `@zakkster/lite-di-container/{signal,reactive}` in their headers,
`DISignal.d.ts` imports `Container` from an unscoped `lite-di-container`, and the
whole layer depends on `createRegistry` from a third package. Meanwhile the suite
law is "Single PascalCase main file" and the core container's entire pitch is
zero runtime dependencies.

This record decides where -- if anywhere -- these two modules ship in 2.0.0. It
is a decision only: no code, no `package.json` edit. X1 implements the outcome.

## Verified facts (checked this session, not assumed)

**The `@zakkster/lite-signal` surface the modules need exists:**

- `createRegistry({ maxNodes, maxLinks, prealloc, onCapacityExceeded,
  maxFlushPasses })` is a real export; the option bag `DISignal.js` passes
  matches the documented signature exactly.
- `destroy()` is a documented registry operation ("resets all pools, rebuilds
  free lists, bumps every node's gen ... safe to call mid-flight"), which is
  what `registerSignalRegistry`'s teardown relies on.

**But the version surface is in flux, which is the whole problem:**

- Published stable on the registry: **1.4.3**.
- Locally installed (pulled in transitively for the torture devDeps):
  **1.5.0-rc.1** -- a release candidate.
- Local working tree holds many parallel lines: `1.6.0-beta`, `1.7.0-alpha`,
  `1.8.0`, `1.9.0-preview`, plus DOM/GSAP/Spring variants.

The API is present, but the code was written against features that live in RC /
preview builds, not the published stable. Pinning that into the container is the
risk this decision exists to avoid.

**Consumer impact of dropping them is zero:**

- `rg -n 'DISignal|DIReactive|lite-di-signal|/signal|/reactive' 2.0.0/dependents`
  returns nothing. All seven first-party dependents (DICron, DIEventBus, DILock,
  DIOrchestrator, DIStrategyRouter, DIT, DITicker) consume only the CORE surface
  (`value`/`singleton`/`transient`/`factory`/`multi`/`get`/`getAll`/`scope`/
  `has`/`onTeardown`/`bootAsync`/`shutdown`/`unregister`). Nothing imports the
  reactive layer.

## Options

### A -- Subpath exports off `lite-di-container`

`package.json` gains `"./signal"` and `"./reactive"` export entries.

- For: the coupling is tight and real (`getReactiveAPI` needs `hasLocal` +
  `onTeardown`; `registerSignalRegistry` needs `singletonFactory` +
  `onTeardown` + the `_resolutionOrder` teardown ordering). One version, no
  skew.
- Against: it puts a hard dependency on `@zakkster/lite-signal` into a package
  whose pitch is zero runtime dependencies. A subpath a user never imports still
  ships in the tarball and still appears in `dependencies`. It also breaks
  "Single PascalCase main file" -- three PascalCase files ship.
- Only-honest variant: `peerDependencies` + `peerDependenciesMeta.optional`, so
  the core install stays dep-free and only subpath users pull lite-signal. Even
  then, three files ship from a package whose law says one.

### B -- A separate `@zakkster/lite-di-signal` package

Depends on `@zakkster/lite-di-container` + `@zakkster/lite-signal`.

- For: honours "Single PascalCase main file" in both repos; the core stays
  provably zero-dep; the module headers ALREADY claim this name, so B makes the
  existing files honest rather than rewriting them.
- Against: two repos, two release cycles, and the container's
  `hasLocal`/`onTeardown`/`_resolutionOrder` semantics become a cross-package
  contract that must be pinned (a FORMAT.md-shaped document). D-20's former
  `container._registry` fallback would become an ACROSS-package private access
  -- unacceptable -- so D6's `hasLocal`/`isBooted` promotion (now shipped) is a
  hard prerequisite, which B satisfies.

### C -- Drop both from 2.0.0

Ship the container alone; revisit reactive integration in 2.1.

- For: the only option whose dependency risk is zero and whose consumer breakage
  is zero (verified above: no dependent imports them). 2.0.0 already carries the
  fixes for twenty findings; bolting a cross-package reactive story onto it,
  against a lite-signal version that is mid-flux, is how a release slips twice.
- Against: the work exists and is mostly written. (It is preserved in the
  gitignored `2.0.0/` staging directory -- `DISignal.js`, `DIReactive.js`,
  `DISignal.d.ts` -- not lost.)

## Decision

**C for 2.0.0, then B for a 2.1-era `@zakkster/lite-di-signal`.**

C is not a retreat: it is the only option whose dependency risk and consumer
breakage are both zero, on a release already carrying twenty findings' worth of
fixes and facing a lite-signal version surface that is churning through RC /
alpha / beta / preview lines with no pinned stable target. B is the right
long-term home because the modules already claim that name and it is the only
option that keeps BOTH the zero-dependency law and the single-main-file law
intact in each repo.

A is rejected: even in its optional-peer form it ships three PascalCase files
from a package whose law says one, and it advertises a dependency the core does
not want.

The prerequisites for B are already met by this v2 line: D6 shipped the public
`hasLocal` and `isBooted` accessors and the `getReactiveAPI` private-`_registry`
fallback is gone from the shipped surface, so a future `lite-di-signal` never
needs to reach into container internals.

## Consequences for X1

- `Container.js` ships alone. `package.json` gains NO `./signal` / `./reactive`
  exports and NO `@zakkster/lite-signal` dependency. `files[]` stays at the
  seven shipped entries; `2.0.0/` remains gitignored staging and never enters
  the tarball (`npm pack --dry-run` proves it).
- The CHANGELOG and README note that a reactive-DI integration is planned as a
  separate `@zakkster/lite-di-signal` package (2.1), depending on this one plus
  `@zakkster/lite-signal`, and that the container exposes `hasLocal`/`isBooted`
  precisely so that package needs no private access.
- Before 2.1 opens, pin the exact published `@zakkster/lite-signal` version that
  exports `createRegistry` with this option bag and a public registry
  `destroy()`, and write the cross-package contract (which container members are
  API for the signal package, and what a breaking change to each means).
