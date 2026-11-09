// Look and sound preferences for this device, kept in localStorage.
// index.html has a tiny copy of the theme logic in <head>, so the page never flashes the wrong colors.
const KEY = 'writing-app:prefs';

export const THEMES = [
  { id: 'paper', name: 'Paper', dark: false },
  { id: 'sepia', name: 'Sepia', dark: false },
  { id: 'mist', name: 'Mist', dark: false },
  { id: 'night', name: 'Night', dark: true },
  { id: 'midnight', name: 'Midnight', dark: true },
  { id: 'forest', name: 'Forest', dark: true },
];

export const FONTS = [
  { id: 'serif', name: 'Serif' },
  { id: 'sans', name: 'Sans' },
  { id: 'typewriter', name: 'Typewriter' },
];

export const SIZES = [
  { id: 's', name: 'Small' },
  { id: 'm', name: 'Medium' },
  { id: 'l', name: 'Large' },
];

const DEFAULTS = { mode: 'auto', light: 'paper', dark: 'night', font: 'serif', size: 'm', voice: '', speed: 1, grammar: true };
const deviceDark = window.matchMedia('(prefers-color-scheme: dark)');

const pick = (list, id, fallback) => (list.some(item => item.id === id) ? id : fallback);

export function loadPrefs() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    saved = {};
  }
  const prefs = { ...DEFAULTS, ...saved };
  prefs.mode = ['auto', 'light', 'dark'].includes(prefs.mode) ? prefs.mode : 'auto';
  prefs.light = pick(THEMES.filter(theme => !theme.dark), prefs.light, DEFAULTS.light);
  prefs.dark = pick(THEMES.filter(theme => theme.dark), prefs.dark, DEFAULTS.dark);
  prefs.font = pick(FONTS, prefs.font, DEFAULTS.font);
  prefs.size = pick(SIZES, prefs.size, DEFAULTS.size);
  prefs.voice = typeof prefs.voice === 'string' ? prefs.voice : '';
  prefs.speed = Number.isFinite(Number(prefs.speed)) ? Math.min(1.4, Math.max(0.7, Number(prefs.speed))) : 1;
  prefs.grammar = prefs.grammar !== false;
  return prefs;
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage is blocked. The choices still apply until the app closes.
  }
}

export function showingDark(prefs) {
  return prefs.mode === 'dark' || (prefs.mode === 'auto' && deviceDark.matches);
}

export function applyLook(prefs) {
  const root = document.documentElement;
  const dark = showingDark(prefs);
  root.dataset.theme = dark ? prefs.dark : prefs.light;
  root.dataset.shade = dark ? 'dark' : 'light';
  root.dataset.font = prefs.font;
  root.dataset.size = prefs.size;
  const background = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
}

export function onDeviceThemeChange(callback) {
  deviceDark.addEventListener('change', callback);
}
