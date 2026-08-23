import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { beforeEach, afterEach } from "vitest";

// --- Feature-flag baseline -------------------------------------------------
// Vite loads `apps/web/.env.local` into `import.meta.env` for TEST runs, not just
// for the dev server. `.env.local` is untracked and holds the flags a developer
// turns on for their own dev app — so without this, that private file silently
// decides test outcomes: every "flag OFF (default)" suite is green in CI (which
// has no `.env.local`) and red on the machine of the person running it.
//
// Strip ambient flag values so each test file starts from the documented default
// (OFF), matching CI exactly. This only clears AMBIENT values; it never blocks an
// opt-in. A test that needs a flag ON still does `vi.stubEnv("VITE_ENABLE_X",
// "true")` as before (see components/__tests__/navigation-billing.test.ts), and
// because the strip happens first, `vi.unstubAllEnvs()` restores to this clean
// baseline rather than to whatever the developer had enabled.
//
// Safe to mutate: `src/lib/feature-flags.ts` reads flags through a COMPUTED
// lookup — `import.meta.env[`VITE_${flag}`]` — not a build-time static
// replacement, so the runtime object is authoritative.
//
// Guarded by `src/test/__tests__/feature-flag-baseline.test.ts`.
{
  const env = import.meta.env as unknown as Record<string, unknown>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITE_ENABLE_")) delete env[key];
  }
}

// --- Storage polyfill ------------------------------------------------------
// vitest's jsdom environment exposes `localStorage` / `sessionStorage` as a
// non-functional empty object ({} — no getItem/setItem/removeItem), so any test
// that calls the Storage API directly throws. Production code guards storage in
// try/catch and degrades silently, but tests assert real round-trips.
//
// Install a working in-memory Storage whose methods live on `Storage.prototype`
// (not as own properties), so existing tests that do
// `vi.spyOn(Storage.prototype, "getItem")` to simulate disabled storage keep
// intercepting. Each instance keeps its own backing Map.
{
  const StorageProto = (globalThis as { Storage?: { prototype: Storage } })
    .Storage?.prototype;
  if (StorageProto) {
    const backing = new WeakMap<object, Map<string, string>>();
    const store = (self: object): Map<string, string> => {
      let m = backing.get(self);
      if (!m) {
        m = new Map();
        backing.set(self, m);
      }
      return m;
    };
    Object.defineProperties(StorageProto, {
      getItem: {
        configurable: true,
        writable: true,
        value(this: object, key: string): string | null {
          const m = store(this);
          return m.has(String(key)) ? m.get(String(key))! : null;
        },
      },
      setItem: {
        configurable: true,
        writable: true,
        value(this: object, key: string, value: string): void {
          store(this).set(String(key), String(value));
        },
      },
      removeItem: {
        configurable: true,
        writable: true,
        value(this: object, key: string): void {
          store(this).delete(String(key));
        },
      },
      clear: {
        configurable: true,
        writable: true,
        value(this: object): void {
          store(this).clear();
        },
      },
      key: {
        configurable: true,
        writable: true,
        value(this: object, index: number): string | null {
          return Array.from(store(this).keys())[index] ?? null;
        },
      },
      length: {
        configurable: true,
        get(this: object): number {
          return store(this).size;
        },
      },
    });

    for (const name of ["localStorage", "sessionStorage"] as const) {
      const instance = Object.create(StorageProto) as Storage;
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: instance,
      });
      if (typeof window !== "undefined") {
        Object.defineProperty(window, name, {
          configurable: true,
          writable: true,
          value: instance,
        });
      }
    }
  }
}

// --- scrollIntoView polyfill ----------------------------------------------
// jsdom does not implement Element.prototype.scrollIntoView, so any component
// that calls it during render/effect (e.g. the bills-grid active-cell focus
// effect keeping the keyboard-driven cell on screen) throws
// "node.scrollIntoView is not a function". Real scrolling/layout is a no-op in
// jsdom by design; install a harmless no-op so the effect runs and its
// FOCUS half (element.focus(), which jsdom DOES implement) can be asserted.
if (
  typeof Element !== "undefined" &&
  typeof Element.prototype.scrollIntoView !== "function"
) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value() {
      /* no-op — jsdom has no layout engine */
    },
  });
}

// --- ResizeObserver polyfill ----------------------------------------------
// BillsGrid and other fit-to-width tables observe their container in the
// browser. jsdom has no layout engine and therefore no ResizeObserver, but the
// components still need a standards-shaped object so render tests can verify
// the remaining behaviour.
if (typeof globalThis.ResizeObserver === "undefined") {
  class TestResizeObserver implements ResizeObserver {
    observe(): void { /* no-op — jsdom has no layout */ }
    unobserve(): void { /* no-op — jsdom has no layout */ }
    disconnect(): void { /* no-op — jsdom has no layout */ }
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: TestResizeObserver,
  });
}

// --- Object-URL polyfill ---------------------------------------------------
// jsdom implements neither URL.createObjectURL nor URL.revokeObjectURL. Any
// component that renders fetched bytes — the transfer-slip viewer in the
// invoice drawer, for one — mints an object URL on load and revokes it on
// unmount, so without these merely UNMOUNTING such a component throws. Worse,
// the throw lands inside testing-library's auto-cleanup, where it reads like a
// framework bug rather than a missing browser API.
//
// A test that asserts on the blob itself still overrides these with vi.fn();
// this only guarantees the functions EXIST, the way a browser guarantees it.
if (typeof URL !== "undefined") {
  let seq = 0;
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => `blob:jsdom/${++seq}`,
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value() {
        /* no-op — nothing is registered to release */
      },
    });
  }
}

// Capture the real Object.defineProperty before any test installs an override.
const origDefProp = Object.defineProperty.bind(Object);

beforeEach(() => {
  // Reset storage so each test starts clean (matches the prior always-empty
  // behaviour, but now via a functioning Storage).
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* ignore */
  }

  // Block userEvent.setup() from replacing navigator.clipboard with its own
  // getter-only stub.  Any Object.assign-based clipboard mock set in a
  // test's beforeEach will therefore survive for the duration of that test.
  Object.defineProperty = function patchedDefineProperty<T>(
    target: T,
    prop: PropertyKey,
    descriptor: PropertyDescriptor & ThisType<unknown>,
  ): T {
    if (target === navigator && String(prop) === "clipboard") return target;
    return origDefProp(target as object, prop, descriptor) as T;
  } as typeof Object.defineProperty;
});

afterEach(() => {
  // Keep rendered trees from leaking into the next test. Some suites run with
  // globals enabled, where Testing Library's implicit cleanup is not reliable.
  cleanup();
  // Restore the original Object.defineProperty for next test.
  Object.defineProperty = origDefProp as typeof Object.defineProperty;
  // Reset navigator.clipboard to a plain writable property so the next
  // test's Object.assign-based mock can set it without errors.
  origDefProp(navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
});
