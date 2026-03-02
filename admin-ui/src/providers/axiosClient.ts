import axios from 'axios';

// In dev, VITE_API_URL can be set to a Vite proxy path (e.g. '/api/manage')
// to avoid CORS issues when testing against production.
export const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)
  ?? 'https://voice.activi.io/api/manage';

export const axiosClient = axios.create({ baseURL: BASE_URL });

// Request: inject Bearer token
axiosClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response: 401 → refresh → retry (once)
let isRefreshing = false;
type RefreshCallback = (token: string) => void;
let refreshQueue: RefreshCallback[] = [];

axiosClient.interceptors.response.use(
  (res) => res,
  async (error: unknown) => {
    if (!axios.isAxiosError(error)) throw error;

    const orig = error.config as typeof error.config & { _retry?: boolean };
    if (error.response?.status !== 401 || orig?._retry) throw error;

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshQueue.push((token) => {
          if (!orig) return reject(error);
          orig.headers = orig.headers ?? {};
          orig.headers.Authorization = `Bearer ${token}`;
          resolve(axiosClient(orig));
        });
      });
    }

    if (!orig) throw error;
    orig._retry = true;
    isRefreshing = true;

    try {
      const refreshToken = localStorage.getItem('refreshToken');
      // WICHTIG: refreshToken im Body (nicht Header)
      const { data } = await axios.post<{ accessToken: string }>(
        `${BASE_URL}/auth/refresh`,
        { refreshToken }
      );
      const newToken = data.accessToken;
      localStorage.setItem('accessToken', newToken);
      refreshQueue.forEach((cb) => cb(newToken));
      refreshQueue = [];
      orig.headers = orig.headers ?? {};
      orig.headers.Authorization = `Bearer ${newToken}`;
      return axiosClient(orig);
    } catch {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      window.location.href = '/app/#/login';
      throw error;
    } finally {
      isRefreshing = false;
    }
  }
);
