import { AuthProvider } from 'react-admin';
import axios from 'axios';
import { BASE_URL } from './axiosClient';
import type { LoginResponse } from '../types';

export const authProvider: AuthProvider = {
  login: async ({ username, password }: { username: string; password: string }) => {
    const { data } = await axios.post<LoginResponse>(`${BASE_URL}/auth/login`, {
      email: username,
      password,
    });
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
  },

  logout: async () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
  },

  checkAuth: async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) throw new Error('Not authenticated');
  },

  checkError: async (error: { status?: number }) => {
    if (error?.status === 401 || error?.status === 403) {
      throw new Error('Unauthorized');
    }
  },

  getIdentity: async () => {
    const raw = localStorage.getItem('user');
    if (!raw) throw new Error('No identity');
    const user = JSON.parse(raw) as { id: string; email: string };
    return { id: user.id, fullName: user.email, avatar: undefined };
  },

  getPermissions: async () => {
    const raw = localStorage.getItem('user');
    if (!raw) return null;
    return (JSON.parse(raw) as { role: string }).role;
  },
};
