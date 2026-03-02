import '@testing-library/jest-dom';

// Node.js 22+ has a built-in global.localStorage that is an empty stub object
// (no clear/getItem/setItem methods) unless --localstorage-file is set to a
// valid path.  Vitest workers run without a valid path, so the bare
// `localStorage` global resolves to this broken stub instead of jsdom's
// working implementation.
//
// Fix: use vi.stubGlobal in beforeEach so the correct mock is always present,
// even after vi.unstubAllGlobals() calls in individual test files.

const makeStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
};

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage());
  vi.stubGlobal('sessionStorage', makeStorage());
});
