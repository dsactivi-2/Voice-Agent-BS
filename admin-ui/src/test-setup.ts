import '@testing-library/jest-dom';

// jsdom 28 + vitest 4 passes --localstorage-file="" which produces a broken
// Storage object missing .clear(). Replace with a complete in-memory impl.
const makeStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
};

Object.defineProperty(window, 'localStorage', { value: makeStorage(), writable: true });
Object.defineProperty(window, 'sessionStorage', { value: makeStorage(), writable: true });
