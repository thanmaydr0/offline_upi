import { useColorScheme } from 'react-native';

const shared = {
  accent: '#176B4D',
  accentBright: '#2CC78A',
  accentSoft: '#E4F5EC',
  warning: '#B86A13',
  warningSoft: '#FFF3DA',
  danger: '#B83C42',
  dangerSoft: '#FCEAEC',
  success: '#178253',
  successSoft: '#E4F5EC',
  white: '#FFFFFF',
  black: '#111714',
  shadow: '#12251B',
} as const;

export const themes = {
  light: {
    ...shared,
    background: '#F5F7F5',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceMuted: '#EEF2EF',
    border: '#E3E9E5',
    text: '#17221C',
    textSecondary: '#66736B',
    textMuted: '#8B9690',
    accentText: '#FFFFFF',
    online: '#1B8E5A',
    offline: '#236D4D',
  },
  dark: {
    ...shared,
    accentSoft: '#183B2E',
    warningSoft: '#3A2C18',
    dangerSoft: '#3C2024',
    successSoft: '#183B2E',
    background: '#101713',
    surface: '#18211C',
    surfaceRaised: '#202C25',
    surfaceMuted: '#253129',
    border: '#304038',
    text: '#F2F6F3',
    textSecondary: '#A8B4AC',
    textMuted: '#78867D',
    accentText: '#062116',
    online: '#2CC78A',
    offline: '#A5E5C4',
  },
} as const;

export type Theme = (typeof themes)[keyof typeof themes];
export type ThemeMode = keyof typeof themes;

export const typeScale = {
  display: { fontSize: 34, lineHeight: 42, fontWeight: '700' as const, letterSpacing: -0.8 },
  title: { fontSize: 25, lineHeight: 32, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' as const },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' as const },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: '500' as const },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export function useAppTheme(): Theme {
  return themes[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
