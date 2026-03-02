import { defaultLightTheme } from 'react-admin';
import type { RaThemeOptions } from 'react-admin';

export const lightTheme: RaThemeOptions = {
  ...defaultLightTheme,
  palette: {
    ...defaultLightTheme.palette,
    mode: 'light',
    primary:   { main: '#1565c0', light: '#1976d2', dark: '#0d47a1', contrastText: '#fff' },
    secondary: { main: '#f57c00', light: '#ff9800', dark: '#e65100', contrastText: '#fff' },
  },
  components: {
    ...defaultLightTheme.components,
    MuiCard: {
      styleOverrides: { root: { borderRadius: 12 } },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 700 } },
    },
    MuiButton: {
      styleOverrides: { root: { borderRadius: 8 } },
    },
  },
};
