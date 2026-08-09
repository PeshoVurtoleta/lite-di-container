# Cookbook

Recipes for `@zakkster/lite-di-container`, from your first container to the
zero-allocation hot path. Every recipe is runnable as written against v2.0.0 and
uses only the public API. ASCII-only, like the rest of the package.

The recipes climb: Recipes 0-4 are the basics, 5-7 are the dependency graph,
8-10 are async, 11-12 are multi-bindings, 13-14 are scopes, 15-17 are lifecycle,
18 is testing, and 19-21 are the "Pro" tier -- the zero-GC hot path and how to
gate it. The last section lists recipes that land with the 2.1 reactive layer
and the dependent packages.

New here? Read Recipe 0, then jump to whatever you are actually trying to do.

## Contents

- [Recipe 0: Your first container](#recipe-0-your-first-container)
- [Recipe 1: A class with dependencies](#recipe-1-a-class-with-dependencies)
- [Recipe 2: Singleton vs transient](#recipe-2-singleton-vs-transient)
- [Recipe 3: Factories](#recipe-3-factories)
- [Recipe 4: Config and third-party values](#recipe-4-config-and-third-party-values)
- [Recipe 5: The dependency graph and the diamond](#recipe-5-the-dependency-graph-and-the-diamond)
- [Recipe 6: boot() -- catch wiring bugs before they run](#recipe-6-boot----catch-wiring-bugs-before-they-run)
- [Recipe 7: Aliases -- swap an implementation behind a name](#recipe-7-aliases----swap-an-implementation-behind-a-name)
- [Recipe 8: Async singletons](#recipe-8-async-singletons)
- [Recipe 9: bootAsync -- warm every async singleton once](#recipe-9-bootasync----warm-every-async-singleton-once)
- [Recipe 10: Why a concurrent async singleton builds exactly once](#recipe-10-why-a-concurrent-async-singleton-builds-exactly-once)
- [Recipe 11: Multi-bindings and getAll](#recipe-11-multi-bindings-and-getall)
- [Recipe 12: Pro: getAllInto -- fan out with zero allocation](#recipe-12-pro-getallinto----fan-out-with-zero-allocation)
- [Recipe 13: Scopes for requests and sessions](#recipe-13-scopes-for-requests-and-sessions)
- [Recipe 14: Scope override without touching the parent](#recipe-14-scope-override-without-touching-the-parent)
- [Recipe 15: Teardown order and onTeardown](#recipe-15-teardown-order-and-onteardown)
- [Recipe 16: Graceful shutdown and the AggregateError contract](#recipe-16-graceful-shutdown-and-the-aggregateerror-contract)
- [Recipe 17: Resolving a collaborator during teardown (DRAINING)](#recipe-17-resolving-a-collaborator-during-teardown-draining)
- [Recipe 18: Tests -- reset, unregister, and mocking](#recipe-18-tests----reset-unregister-and-mocking)
- [Recipe 19: Pro: the hot lane is 0 bytes per call](#recipe-19-pro-the-hot-lane-is-0-bytes-per-call)
- [Recipe 20: Pro: gating your resolve path with lite-gc-profiler](#recipe-20-pro-gating-your-resolve-path-with-lite-gc-profiler)
- [Recipe 21: Pro: failing closed](#recipe-21-pro-failing-closed)
- [Coming with 2.1 and the dependents](#coming-with-21-and-the-dependents)

## The lifecycle at a glance

```
register  --->  boot()  --->  get()/getAsync()  --->  shutdown()
  (cold)       validate       resolve + cache        teardown in
              the graph,     (cached hit = 0 B)      reverse order,
              lock topology                          then release
```

- Everything before `boot()` is the **cold path** -- register freely.
- `boot()` validates the whole declared graph (missing deps, cycles) and locks
  registration. After boot, resolution is the only thing you do.
- `get()` on a cached binding is the **hot path** -- one state check, one map
  lookup, return. Zero bytes allocated (Recipe 19).
- `shutdown()` tears services down in reverse resolution order and releases every
  retained instance (Recipe 16).

---

## Recipe 0: Your first container

**Goal.** Register something, resolve it.

```js
import { Container } from '@zakkster/lite-di-container';

const c = new Container();
c.value('config', { port: 3000 });

console.log(c.get('config').port); // 3000
```

`value()` stores a reference and returns it as-is on every `get()`. Nothing is
constructed, nothing is copied.

Note: registration methods do **not** chain (v2 removed fluent `this` returns).
Call them one per line.

---

## Recipe 1: A class with dependencies

**Goal.** Have the container build an object graph for you.

```js
class Db {
  constructor(config) { this.port = config.port; }
}
class UserRepo {
  constructor(db) { this.db = db; }
}

const c = new Container();
c.value('config', { port: 5432 });
c.singleton('db', Db, ['config']);
c.singleton('userRepo', UserRepo, ['db']);

const repo = c.get('userRepo'); // builds config -> db -> userRepo
```

The third argument is the ordered list of dependency tokens. The container
resolves each, then calls `new Class(...resolved)`. A token can be a string or a
symbol.

---

## Recipe 2: Singleton vs transient

**Goal.** Choose between "one shared instance" and "a fresh one every time".

```js
c.singleton('pool', Pool);   // built once, cached, shared
c.transient('cmd', Command); // new Command() on every get()

c.get('pool') === c.get('pool'); // true
c.get('cmd')  === c.get('cmd');  // false
```

Use `singleton` for anything with state or an expensive setup (pools, caches,
clients). Use `transient` for short-lived, per-use objects.

---

## Recipe 3: Factories

**Goal.** Build a value with a function instead of a constructor.

```js
import { randomUUID } from 'node:crypto';

c.factory('requestId', () => randomUUID());   // called every get()
c.singletonFactory('clock', () => new Clock()); // called once, cached

c.get('requestId'); // a new id each call
c.get('clock');     // same clock every call
```

A factory receives the container, so it can resolve its own dependencies:

```js
c.factory('greeter', (con) => new Greeter(con.get('config')));
```

`factory` runs every time; `singletonFactory` caches the first result (including
`undefined` -- a resolved `undefined` is distinct from "not yet resolved"). For
the async forms, see Recipe 8.

---

## Recipe 4: Config and third-party values

**Goal.** Put plain objects, primitives, or an imported module into the graph.

```js
import pino from 'pino';

c.value('env', process.env);
c.value('logger', pino());
c.value('featureFlags', { fastCheckout: true });
```

`value()` is the right tool for anything you did not construct yourself and want
handed back untouched. Do not wrap a plain object in `singleton` -- it is not a
class and the container would refuse to `new` it.

---

## Recipe 5: The dependency graph and the diamond

**Goal.** Share one instance across several dependents.

```js
c.singleton('db', Db, ['config']);
c.singleton('users', UsersService, ['db']);
c.singleton('orders', OrdersService, ['db']);
c.singleton('api', Api, ['users', 'orders']);

const api = c.get('api');
api.users.db === api.orders.db; // true -- one db, shared down both arms
```

Because `db` is a singleton, the diamond `api -> {users, orders} -> db` resolves
`db` once and both arms get the same instance. A `transient` in that spot would
be built twice -- once per arm.

---

## Recipe 6: boot() -- catch wiring bugs before they run

**Goal.** Fail at startup on a typo'd dependency or a cycle, not at 3am.

```js
c.singleton('a', A, ['b']);
c.singleton('b', B, ['databse']); // typo

c.boot();
// throws: "databse" is not registered  (all wiring errors listed at once)
```

`boot()` walks every declared dependency and every alias target, collects **all**
wiring errors into one message, and runs static cycle detection over the graph --
without constructing anything. It then locks registration: after `boot()`,
`value`/`singleton`/... throw. Call `boot()` once, after wiring is complete.

Cycles are caught statically at boot and again at resolution:

```js
c.singleton('x', X, ['y']);
c.singleton('y', Y, ['x']);
c.boot(); // throws: circular dependency: x -> y -> x
```

Factories resolve their deps dynamically, so `boot()` cannot see inside them --
a factory's bad `get()` still surfaces at first resolve.

---

## Recipe 7: Aliases -- swap an implementation behind a name

**Goal.** Let callers depend on a role name while you choose the implementation.

```js
c.singleton('postgresStore', PostgresStore, ['config']);
c.singleton('memoryStore', MemoryStore);

c.alias('store', process.env.NODE_ENV === 'test' ? 'memoryStore' : 'postgresStore');

c.get('store'); // resolves through the alias to the chosen implementation
```

An alias is a transparent redirect: `get('store')` returns exactly what
`get('postgresStore')` would, and the alias name appears in error traces so you
can see the path you actually asked for. Aliases participate in `boot()`
validation -- an alias to nothing is a wiring error.

---

## Recipe 8: Async singletons

**Goal.** Build a dependency that needs `await` (a connection, a warm cache).

```js
c.singletonFactoryAsync('db', async () => {
  const pool = new Pool(config);
  await pool.connect();
  return pool;
});

const db = await c.getAsync('db');
```

Async bindings must be resolved with `getAsync` (a plain `get('db')` throws
`'db' is async. Use getAsync().`). `getAsync` threads a per-resolution context,
so cross-factory async cycles are detected and rejected with a full trace instead
of hanging.

The async families mirror the sync ones: `factoryAsync` (every call) and
`singletonFactoryAsync` (cached).

---

## Recipe 9: bootAsync -- warm every async singleton once

**Goal.** Pay all async construction cost at startup, not on the first request.

```js
c.singletonFactoryAsync('db', connectDb);
c.singletonFactoryAsync('cache', connectCache);

await c.bootAsync(); // runs boot() validation, then resolves every async singleton
// db and cache are now built and cached; getAsync returns them instantly
```

`bootAsync()` runs the same graph validation as `boot()`, then eagerly resolves
every cached async binding concurrently. After it returns, your async singletons
are warm.

---

## Recipe 10: Why a concurrent async singleton builds exactly once

**Goal.** Understand the dedupe guarantee -- it matters under load.

```js
c.singletonFactoryAsync('db', async () => { await tick(); return new Pool(); });

const [a, b] = await Promise.all([c.getAsync('db'), c.getAsync('db')]);
a === b; // true -- the factory ran once, not twice
```

An async singleton memoizes the **in-flight promise**, not just the resolved
value, so N concurrent callers share one construction. If the factory rejects,
the entry is evicted so a later `getAsync` can retry rather than being stuck with
a permanently-poisoned promise.

---

## Recipe 11: Multi-bindings and getAll

**Goal.** Register many implementations under one name (plugins, handlers).

```js
class LogSink { handle(e) { /* ... */ } }
class MetricsSink { handle(e) { /* ... */ } }

c.multi('sink', LogSink);
c.multi('sink', MetricsSink);

for (const sink of c.getAll('sink')) sink.handle(event);
```

`multi`/`multiFactory` append to a list under the name; `getAll` returns all
resolved instances (cached ones stay cached). A single-binding name and a
multi-binding name are kept separate -- `get()` on a multi name throws and tells
you to use `getAll`, so a multi list can never leak out as a mutable array by
accident.

---

## Recipe 12: Pro: getAllInto -- fan out with zero allocation

**Goal.** Dispatch to every implementation on a hot path without allocating.

`getAll(name)` allocates a fresh array each call. On a per-event or per-frame
path that is real garbage. `getAllInto(name, out)` fills a buffer you own and
allocates **zero** bytes when the multi is fully cached:

```js
const c = new Container();
c.multi('sink', LogSink);
c.multi('sink', MetricsSink);
c.boot();

const out = new Array(2);        // allocate ONCE, outside the loop
c.getAllInto('sink', out);       // warm the cache once

function onEvent(e) {
  const n = c.getAllInto('sink', out); // 0 bytes/call on the hot path
  for (let i = 0; i < n; i++) out[i].handle(e);
}
```

`getAllInto` returns the count written and throws if `out` is not an array or is
too short. This is the idiom the dependent packages (event bus, ticker) use for
their emit/frame loops.

---

## Recipe 13: Scopes for requests and sessions

**Goal.** Give each request its own instances while sharing the app-wide ones.

```js
const app = new Container();
app.singleton('db', Db, ['config']);   // app-wide, shared
app.boot();

function handle(req) {
  const scope = app.scope();
  scope.singleton('requestCtx', RequestCtx); // per-request
  const ctx = scope.get('requestCtx');
  const db = scope.get('db');  // inherited from the parent, the SAME shared db
  // ... handle ...
  return scope.shutdown();     // tears down only what this scope built
}
```

A child scope resolves anything it does not define from its parent, and a
parent binding it resolves is owned, cached, and torn down by the **parent** --
a child never writes into a parent's caches.

---

## Recipe 14: Scope override without touching the parent

**Goal.** Replace a binding for one scope only.

```js
const parent = new Container();
parent.singleton('mailer', SmtpMailer);
const real = parent.get('mailer');

const scope = parent.scope();
scope.singleton('mailer', FakeMailer);   // override in this scope

scope.get('mailer') !== real;   // true -- scope has its own
parent.get('mailer') === real;  // true -- parent is untouched
```

Overriding in a scope shadows the parent binding for that scope only. The
parent's instance and resolution order are unchanged.

---

## Recipe 15: Teardown order and onTeardown

**Goal.** Release resources in the right order, automatically.

```js
class Db     { async close() { /* ... */ } }
class Repo   { constructor(db) {} async close() {} }
class Server { constructor(repo) {} async close() {} }

c.singleton('db', Db);
c.singleton('repo', Repo, ['db']);
c.singleton('server', Server, ['repo']);
c.get('server');

await c.shutdown(); // closes server, then repo, then db -- reverse of construction
```

`shutdown()` walks resolution order in reverse, so a dependency is always torn
down after its dependents. It looks for, in order: a registered `onTeardown`
hook, `Symbol.asyncDispose`/`Symbol.dispose`, then `close()`, then `destroy()`.
Register an explicit hook when the cleanup is not a method on the instance:

```js
c.singletonFactory('bus', () => makeBus());
c.onTeardown('bus', (bus) => bus.unsubscribeAll());
```

---

## Recipe 16: Graceful shutdown and the AggregateError contract

**Goal.** Know whether every teardown succeeded -- without the library eating errors.

```js
try {
  await c.shutdown();
} catch (err) {
  // err is an AggregateError; err.errors holds each teardown failure
  for (const e of err.errors) log.error(e);
}
```

`shutdown()` runs **every** teardown even if some throw (isolation), then rejects
with an `AggregateError` collecting the failures. It never writes to `console`.
Prefer a hook if you would rather not catch:

```js
await c.shutdown({ onTeardownError: (err, name) => log.error({ name }, err) });
```

After a successful shutdown the container has released every cached instance,
resolution order, flags, teardowns, and pending promises -- it retains nothing.
Shutting down a parent while a child scope is still live throws; shut children
down first.

---

## Recipe 17: Resolving a collaborator during teardown (DRAINING)

**Goal.** Let a teardown use an already-built dependency safely.

```js
c.singletonFactory('logger', makeLogger);
c.singletonFactory('worker', makeWorker);
c.onTeardown('worker', (w) => {
  c.get('logger').info('draining worker'); // OK: logger is already cached
  return w.drain();
});

await c.shutdown();
```

During `shutdown()` the container enters a DRAINING state: resolving an
**already-cached** binding (a hit) still works, so a teardown can log or flush
through a collaborator. Constructing a **new** instance mid-shutdown is rejected
-- building something new while the graph is being torn down would re-add it to
the teardown order after the walk had passed it.

---

## Recipe 18: Tests -- reset, unregister, and mocking

**Goal.** Swap a real dependency for a mock, cleanly, between tests.

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let c;
beforeEach(() => { c = new Container(); });

test('service uses the store', () => {
  c.singleton('store', FakeStore);
  c.singleton('svc', Service, ['store']);
  assert.equal(c.get('svc').store.constructor.name, 'FakeStore');
});
```

Three teardown tools:

- `reset()` -- drop all cached instances and unlock registration, keeping the
  registrations. Good for reusing a wired container across tests.
- `unregister(name)` -- remove one binding (and its cache). Requires an unlocked
  container: call `reset()` first if you have booted.
- `clear()` -- wipe everything.

To swap a booted binding: `reset()`, then `unregister('db')`, then register the
mock, then `boot()` again. (The container fails closed here: `unregister`/`clear`
throw on a booted container so you cannot mutate a locked graph by accident.)

---

## Recipe 19: Pro: the hot lane is 0 bytes per call

**Goal.** Understand which resolutions allocate, so you can keep the hot path clean.

The container gates its own allocation per lane. Measured with lite-gc-profiler
(`stabilize: 'deep'`):

| Lane | Cost | Why |
| --- | --- | --- |
| `get()` on a cached singleton / value / alias | **0 B/call** | one state check, one map lookup, return |
| `getAllInto(name, out)` on a cached multi | **0 B/call** | fills your buffer, allocates nothing |
| `get()` on a transient | ~1 array + the instance | `new Array(deps)` + `new Class(...)`, by construction |
| `getAll(name)` | 1 array/call | a fresh result array each call -- use `getAllInto` on hot paths |
| `getAsync()` on a cached hit | 1 promise/frame | async allocates a promise per frame, unavoidable |

The rule: **resolve once, outside the loop; on the hot path call `get()` on
cached singletons and `getAllInto` for fan-out.** Everything hot is then zero
allocation.

---

## Recipe 20: Pro: gating your resolve path with lite-gc-profiler

**Goal.** Prove your own hot path does not allocate, in CI.

```js
import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';

const c = new Container();
c.singleton('svc', Service, ['config']);
c.value('config', {});
c.boot();
c.get('svc'); // warm the cache

const summary = measureAllocs(() => c.get('svc'), { maxBytesPerCall: 0 });
if (!checkAllocs(summary, { maxBytesPerCall: 0 }).ok) {
  throw new Error('hot resolve path allocated');
}
```

Measure the exact call your request handler makes on its hot path. A cached
`get()` and a `getAllInto` fan-out both gate at zero. If your number is not zero,
you are resolving a transient or calling `getAll` in the loop -- move the
allocation to setup (see Recipe 12). See the lite-gc-profiler cookbook for
lanes, thresholds, and CI wiring.

---

## Recipe 21: Pro: failing closed

**Goal.** Rely on the container to reject bad state instead of limping on.

The container fails closed by design; lean on it:

```js
c.value(42, x);              // throws: a token must be a non-empty string or a symbol
c.get('nope');               // throws: not registered, and lists what IS available
c.factory('f', 'not a fn');  // throws: a factory must be a function (at registration)
c.boot(); c.unregister('x'); // throws: cannot mutate a locked (booted) container
await c.getAsync('x'); c.get('x'); // async binding via get() throws -- wrong method
```

Two accessors let you branch without a try/catch:

```js
if (c.hasLocal('feature')) { /* defined in THIS scope, not a parent */ }
if (!c.isBooted) c.boot();
```

`hasLocal` checks this scope only (no parent walk) -- useful when a scope must
own a binding rather than inherit it. `isBooted` is the public flag; never reach
for private fields.

---

## Coming with 2.1 and the dependents

This cookbook grows with the ecosystem. Planned recipes:

- **The reactive layer (2.1, `@zakkster/lite-di-signal`).** Registering a scoped
  signal registry, wiring `signal`/`computed`/`effect` as scoped services, and
  reverse-topological teardown of reactive effects. See decision record
  `decisions/0004-signal-packaging.md`.
- **The dependent packages.** Each `@zakkster/lite-di-*` package built on this
  container will contribute its own recipes -- scheduling, event topologies,
  scoped locks, server lifecycle, strategy selection, frame ticking -- once its
  design is validated against v2.0.0. Those recipes will slot in here by theme.

Have a pattern worth adding? The recipes above are the spine; the ecosystem
fills in the rest.
