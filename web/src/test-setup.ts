import "@testing-library/jest-dom/vitest";

// jsdom does not implement scrollIntoView — stub it globally
window.HTMLElement.prototype.scrollIntoView = () => {};

// jsdom's localStorage implementation can be non-functional — replace with a
// reliable in-memory stub so components that use localStorage work in tests.
const _lsStore: Record<string, string> = {};
const _lsStub = {
  getItem: (key: string) => _lsStore[key] ?? null,
  setItem: (key: string, value: string) => {
    _lsStore[key] = String(value);
  },
  removeItem: (key: string) => {
    delete _lsStore[key];
  },
  clear: () => {
    Object.keys(_lsStore).forEach((k) => delete _lsStore[k]);
  },
  key: (index: number) => Object.keys(_lsStore)[index] ?? null,
  get length() {
    return Object.keys(_lsStore).length;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: _lsStub,
  writable: true,
  configurable: true,
});
