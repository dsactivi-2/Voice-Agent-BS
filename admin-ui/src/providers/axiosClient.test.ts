import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MockAdapter from 'axios-mock-adapter';
import axios from 'axios';
import { axiosClient, BASE_URL } from './axiosClient';

// Attach mock adapters once — MockAdapter intercepts at the adapter level
const mockClient = new MockAdapter(axiosClient, { onNoMatch: 'throwException' });
const mockVanilla = new MockAdapter(axios, { onNoMatch: 'throwException' });

const REFRESH_URL = `${BASE_URL}/auth/refresh`;

beforeEach(() => {
  localStorage.clear();
  mockClient.reset();
  mockVanilla.reset();
  vi.stubGlobal('location', { href: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Request interceptor ──────────────────────────────────────────────────────

describe('request interceptor', () => {
  it('injects Bearer token from localStorage when present', async () => {
    localStorage.setItem('accessToken', 'tok-abc');
    mockClient.onGet('/ping').reply(200, {});

    await axiosClient.get('/ping');

    const req = mockClient.history.get[0];
    expect(req.headers?.Authorization).toBe('Bearer tok-abc');
  });

  it('omits Authorization header when no token in localStorage', async () => {
    mockClient.onGet('/ping').reply(200, {});

    await axiosClient.get('/ping');

    const req = mockClient.history.get[0];
    expect(req.headers?.Authorization).toBeUndefined();
  });
});

// ── Response interceptor: non-401 passthrough ────────────────────────────────

describe('response interceptor — non-401', () => {
  it('returns 200 responses unchanged', async () => {
    mockClient.onGet('/data').reply(200, { ok: true });

    const res = await axiosClient.get('/data');

    expect(res.data).toEqual({ ok: true });
  });

  it('re-throws non-401 errors without triggering refresh', async () => {
    mockClient.onGet('/data').reply(404);

    await expect(axiosClient.get('/data')).rejects.toMatchObject({
      response: { status: 404 },
    });
    // No refresh call was made
    expect(mockVanilla.history.post).toHaveLength(0);
  });

  it('re-throws 500 errors without triggering refresh', async () => {
    mockClient.onGet('/data').reply(500);

    await expect(axiosClient.get('/data')).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(mockVanilla.history.post).toHaveLength(0);
  });
});

// ── Response interceptor: 401 → refresh → retry ──────────────────────────────

describe('response interceptor — 401 handling', () => {
  it('on 401 with valid refresh token: refreshes, retries, returns data', async () => {
    localStorage.setItem('accessToken', 'old-tok');
    localStorage.setItem('refreshToken', 'ref-tok');

    let callCount = 0;
    mockClient.onGet('/secret').reply(() => {
      callCount++;
      if (callCount === 1) return [401, {}];
      return [200, { secret: 'payload' }];
    });
    mockVanilla.onPost(REFRESH_URL).reply(200, { accessToken: 'new-tok' });

    const res = await axiosClient.get('/secret');

    expect(res.data).toEqual({ secret: 'payload' });
    expect(localStorage.getItem('accessToken')).toBe('new-tok');
    expect(callCount).toBe(2);
  });

  it('on 401: retry request carries new token in Authorization header', async () => {
    localStorage.setItem('accessToken', 'old-tok');
    localStorage.setItem('refreshToken', 'ref-tok');

    let callCount = 0;
    mockClient.onGet('/protected').reply(() => {
      callCount++;
      if (callCount === 1) return [401, {}];
      return [200, {}];
    });
    mockVanilla.onPost(REFRESH_URL).reply(200, { accessToken: 'fresh-tok' });

    await axiosClient.get('/protected');

    const retryReq = mockClient.history.get[1];
    expect(retryReq.headers?.Authorization).toBe('Bearer fresh-tok');
  });

  it('on 401 refresh failure: clears localStorage and redirects to login', async () => {
    localStorage.setItem('accessToken', 'expired');
    localStorage.setItem('refreshToken', 'bad-ref');

    mockClient.onGet('/protected').reply(401);
    mockVanilla.onPost(REFRESH_URL).reply(401, { error: 'invalid_refresh' });

    await expect(axiosClient.get('/protected')).rejects.toBeDefined();

    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(window.location.href).toBe('/app/#/login');
  });

  it('on 401 without refresh token: still clears storage and redirects', async () => {
    localStorage.setItem('accessToken', 'tok');
    // No refreshToken set

    mockClient.onGet('/protected').reply(401);
    mockVanilla.onPost(REFRESH_URL).networkError();

    await expect(axiosClient.get('/protected')).rejects.toBeDefined();

    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(window.location.href).toBe('/app/#/login');
  });

  it('concurrent 401s: queues second request, only one refresh call is made', async () => {
    // This test covers the isRefreshing === true queue path (lines 30-38 of axiosClient.ts).
    // Both requests get 401 simultaneously. The first triggers the refresh; the second
    // is queued and retried automatically with the new token once refresh completes.
    localStorage.setItem('accessToken', 'old-tok');
    localStorage.setItem('refreshToken', 'ref-tok');

    let r1Calls = 0;
    let r2Calls = 0;
    mockClient.onGet('/r1').reply(() => {
      r1Calls++;
      return r1Calls === 1 ? [401, {}] : [200, { from: 'r1' }];
    });
    mockClient.onGet('/r2').reply(() => {
      r2Calls++;
      return r2Calls === 1 ? [401, {}] : [200, { from: 'r2' }];
    });
    mockVanilla.onPost(REFRESH_URL).reply(200, { accessToken: 'shared-tok' });

    const [res1, res2] = await Promise.all([
      axiosClient.get('/r1'),
      axiosClient.get('/r2'),
    ]);

    expect(res1.data).toEqual({ from: 'r1' });
    expect(res2.data).toEqual({ from: 'r2' });
    // Exactly one refresh call — the second request was queued, not independently refreshed
    expect(mockVanilla.history.post).toHaveLength(1);
    expect(localStorage.getItem('accessToken')).toBe('shared-tok');
  });
});
