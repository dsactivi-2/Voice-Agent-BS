import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { authProvider } from './authProvider';
import { BASE_URL } from './axiosClient';

vi.spyOn(axios, 'post');
const mockPost = vi.mocked(axios.post);

beforeEach(() => {
  localStorage.clear();
  mockPost.mockReset();
});

// ── login ────────────────────────────────────────────────────────────────────

describe('authProvider.login', () => {
  it('posts credentials to /auth/login and stores tokens in localStorage', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        accessToken: 'acc-tok',
        refreshToken: 'ref-tok',
        user: { id: 'u1', email: 'admin@activi.io', role: 'admin' },
      },
    });

    await authProvider.login({ username: 'admin@activi.io', password: 'secret' });

    expect(mockPost).toHaveBeenCalledWith(`${BASE_URL}/auth/login`, {
      email: 'admin@activi.io',
      password: 'secret',
    });
    expect(localStorage.getItem('accessToken')).toBe('acc-tok');
    expect(localStorage.getItem('refreshToken')).toBe('ref-tok');
    expect(JSON.parse(localStorage.getItem('user') ?? '{}')).toMatchObject({
      email: 'admin@activi.io',
      role: 'admin',
    });
  });

  it('propagates errors from failed login (wrong credentials)', async () => {
    mockPost.mockRejectedValueOnce(new Error('401 Unauthorized'));

    await expect(
      authProvider.login({ username: 'bad@email.com', password: 'wrong' }),
    ).rejects.toThrow('401 Unauthorized');

    expect(localStorage.getItem('accessToken')).toBeNull();
  });
});

// ── logout ───────────────────────────────────────────────────────────────────

describe('authProvider.logout', () => {
  it('removes all auth keys from localStorage', async () => {
    localStorage.setItem('accessToken', 'tok');
    localStorage.setItem('refreshToken', 'ref');
    localStorage.setItem('user', '{"id":"1"}');

    await authProvider.logout();

    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });
});

// ── checkAuth ────────────────────────────────────────────────────────────────

describe('authProvider.checkAuth', () => {
  it('resolves when accessToken is present', async () => {
    localStorage.setItem('accessToken', 'valid-tok');

    await expect(authProvider.checkAuth({})).resolves.toBeUndefined();
  });

  it('throws when accessToken is absent', async () => {
    await expect(authProvider.checkAuth({})).rejects.toThrow('Not authenticated');
  });
});

// ── checkError ───────────────────────────────────────────────────────────────

describe('authProvider.checkError', () => {
  it('throws on 401', async () => {
    await expect(authProvider.checkError({ status: 401 })).rejects.toThrow('Unauthorized');
  });

  it('throws on 403', async () => {
    await expect(authProvider.checkError({ status: 403 })).rejects.toThrow('Unauthorized');
  });

  it('resolves on 404 (not an auth error)', async () => {
    await expect(authProvider.checkError({ status: 404 })).resolves.toBeUndefined();
  });

  it('resolves on 500 (not an auth error)', async () => {
    await expect(authProvider.checkError({ status: 500 })).resolves.toBeUndefined();
  });

  it('resolves when status is undefined', async () => {
    await expect(authProvider.checkError({})).resolves.toBeUndefined();
  });
});

// ── getIdentity ──────────────────────────────────────────────────────────────

describe('authProvider.getIdentity', () => {
  it('returns id and fullName from localStorage user', async () => {
    localStorage.setItem(
      'user',
      JSON.stringify({ id: 'u-42', email: 'test@activi.io', role: 'admin' }),
    );

    const identity = await authProvider.getIdentity!();

    expect(identity.id).toBe('u-42');
    expect(identity.fullName).toBe('test@activi.io');
    expect(identity.avatar).toBeUndefined();
  });

  it('throws when no user in localStorage', async () => {
    await expect(authProvider.getIdentity!()).rejects.toThrow('No identity');
  });
});

// ── getPermissions ───────────────────────────────────────────────────────────

describe('authProvider.getPermissions', () => {
  it('returns role from localStorage user', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', email: 'x', role: 'admin' }));

    const perm = await authProvider.getPermissions!({});

    expect(perm).toBe('admin');
  });

  it('returns null when no user in localStorage', async () => {
    const perm = await authProvider.getPermissions!({});

    expect(perm).toBeNull();
  });
});
