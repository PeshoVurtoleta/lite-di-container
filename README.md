# Lite DI Container

A lightweight, zero-magic Dependency Injection container for modern JavaScript and TypeScript.

Unlike heavy frameworks that rely on decorators, reflection, or magic string parsing, this container embraces **explicit registration**. You tell it exactly what a dependency is (a value, a singleton, a transient, or a factory), and it handles the rest.

## Features

- **Zero Magic**: Explicit API (`value`, `singleton`, `transient`, `factory`). No guessing game.
- **Fail-Fast Boot Validation**: Validates the entire dependency graph at startup. Catches typos and misconfigurations before your app even begins serving traffic.
- **Advanced Cycle Detection**: Detects circular dependencies (e.g., `A → B → A`) both at runtime and via a dry-run Depth-First Search during the `boot()` phase.
- **Boot Lock**: After `boot()`, the container is sealed — no accidental runtime registrations.
- **Test-Driven Design**: Built-in methods to lock, unlock, reset, and selectively unregister services for easy mocking in integration tests.
- **First-Class TypeScript Support**: Includes comprehensive `.d.ts` types with generic support for perfect IDE autocomplete.

## Installation

```bash
npm install lite-di-container
```

## Quick Start

### 1. Register your services

```javascript
import { Container } from 'lite-di-container';

const container = new Container();

// 1. Register a raw value (returned as-is)
container.value('config', { port: 3000 });

// 2. Register a Singleton (instantiated once lazily, cached forever)
class Database {
    constructor(config) { this.port = config.port; }
}
container.singleton('db', Database, ['config']);

// 3. Register a Transient (new instance created on every get)
class Logger {
    log(msg) { console.log(msg); }
}
container.transient('logger', Logger);

// 4. Register a Factory (function called on every get)
container.factory('requestId', () => crypto.randomUUID());
```

### 2. Validate and Lock the Graph

Always call `boot()` before starting your application. This locks the container (preventing accidental runtime registrations), checks that all required dependencies exist, and scans for circular dependency loops.

```javascript
container.boot();
```

### 3. Resolve Dependencies

```javascript
const db = container.get('db'); // Instantiates Database and injects 'config'
```

If you are using TypeScript, you can pass generics to `get` for full type inference:

```typescript
const db = container.get<Database>('db');
```

## API

### Registration

| Method | Description |
|--------|-------------|
| `.value(name, val)` | Register a raw value — returned as-is on every `get()` |
| `.singleton(name, Class, deps?)` | Register a class — instantiated once on first `get()`, cached thereafter |
| `.transient(name, Class, deps?)` | Register a class — new instance on every `get()` |
| `.factory(name, fn)` | Register a function — called on every `get()`, receives the container |

### Resolution

| Method | Description |
|--------|-------------|
| `.get(name)` | Resolve a service by name |
| `.has(name)` | Check if a service is registered (no resolution) |

### Validation & Lifecycle

| Method | Description |
|--------|-------------|
| `.boot()` | Validate wiring + lock the container |
| `.reset()` | Flush singleton caches + unlock for re-registration |
| `.unregister(name)` | Remove a single service (must call `reset()` first if booted) |
| `.clear()` | Remove everything — full teardown |

## Testing & Mocking

The container is designed to make integration testing painless. Use `reset()` to unlock the container and flush cached instances, then swap dependencies freely:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import container from './my-app-container.js';
import { MockDatabase } from './mocks.js';

describe('My App', () => {
    beforeEach(() => {
        // Unlock the container and clear cached singletons
        container.reset();

        // Swap the real DB for a mock
        container.unregister('db');
        container.singleton('db', MockDatabase);

        // Re-validate the graph
        container.boot();
    });

    it('should use the mocked database', () => {
        const db = container.get('db');
        expect(db).toBeInstanceOf(MockDatabase);
    });
});
```

## Safety Features

### Boot Lock

After `boot()`, any attempt to register, unregister, or modify services throws immediately:

```javascript
container.boot();
container.value('late', 123); // Error: cannot modify registrations after boot()
```

Call `reset()` or `clear()` to unlock.

### Circular Dependency Detection

Detected both statically (at `boot()` time via DFS) and at runtime (during `get()` resolution):

```javascript
class A { constructor(b) {} }
class B { constructor(a) {} }

container.transient('a', A, ['b']);
container.transient('b', B, ['a']);
container.boot(); // Error: circular dependency detected: a → b → a
```

Factory-based cycles are caught at runtime:

```javascript
container.factory('ping', (c) => c.get('pong'));
container.factory('pong', (c) => c.get('ping'));
container.get('ping'); // Error: circular dependency detected: ping → pong → ping
```

### Arrow Function Guard

Arrow functions can't be instantiated with `new`. The container catches this at registration time instead of letting it crash at runtime:

```javascript
container.singleton('bad', () => {});
// Error: "bad" is an arrow function and cannot be instantiated with `new`.
// Use .factory() for arrow functions or .value() for static utilities.
```

## Known Limitations

- **Factory dependencies are dynamic**: `boot()` validates declared dependency arrays but cannot inspect factory function bodies. A typo inside `c.get('dataBse')` will only surface when the factory is first called.
- **Arrow function detection is heuristic**: Uses `.prototype` check, which covers all practical cases but could theoretically be fooled by `Object.defineProperty`.

## License

MIT
