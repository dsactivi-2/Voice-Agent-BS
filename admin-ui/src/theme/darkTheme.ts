import { defaultDarkTheme } from 'react-admin';
import type { RaThemeOptions } from 'react-admin';

export const darkTheme: RaThemeOptions = {
  ...defaultDarkTheme,
  palette: {
    ...defaultDarkTheme.palette,
    mode: 'dark',
    primary:   { main: '#2196f3', light: '#64b5f6', dark: '#1565c0', contrastText: '#fff' },
    secondary: { main: '#ff9800', light: '#ffb74d', dark: '#e65100', contrastText: '#fff' },
    error:     { main: '#f44336' },
    success:   { main: '#4caf50' },
    warning:   { main: '#ff9800' },
    background: { default: '#0d0d0d', paper: '#1a1a1a' },
  },
  components: {
    ...defaultDarkTheme.components,
    MuiCard: {
      styleOverrides: { root: { borderRadius: 12, backgroundImage: 'none' } },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 700 } },
    },
    MuiButton: {
      styleOverrides: { root: { borderRadius: 8 } },
    },
    MuiTableRow: {
      styleOverrides: {
        root: { '&:hover': { backgroundColor: 'rgba(255,255,255,0.04)' } },
      },
    },
  },
};
