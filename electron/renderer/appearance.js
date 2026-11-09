import { icon } from './icons.js';

const THEME_KEY = 'autovpn.ui.theme';
const THEMES = ['system', 'light', 'dark'];

// Presentation preferences must work when browser storage is disabled, too.
export function readPreference(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A blocked/full store only disables persistence; the current UI still works.
  }
}

export function getThemePreference() {
  const saved = readPreference(THEME_KEY, 'system');
  return THEMES.includes(saved) ? saved : 'system';
}

export function applyTheme(preference = getThemePreference()) {
  const choice = THEMES.includes(preference) ? preference : 'system';
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePreference = choice;
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
  }
}

export function selectTheme(preference) {
  writePreference(THEME_KEY, preference);
  applyTheme(preference);
}

export function toggleSidebar() {
  const collapsed = document.documentElement.dataset.sidebarCollapsed !== 'true';
  writePreference('autovpn.ui.sidebarCollapsed', collapsed);
  applySidebar(collapsed);
}

function applySidebar(collapsed) {
  document.documentElement.dataset.sidebarCollapsed = String(collapsed);
  const button = document.querySelector('#sidebarToggle');
  if (!button) return;
  const label = collapsed ? '展开导航' : '收起导航';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.title = label;
  button.innerHTML = icon(collapsed ? 'right' : 'left');
}

export function initializeAppearance() {
  applySidebar(readPreference('autovpn.ui.sidebarCollapsed', false) === true);
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (document.documentElement.dataset.themePreference === 'system') applyTheme('system');
  });
  const timers = new WeakMap();
  // Keep native scrolling and drag behavior. Only the thumb's paint changes,
  // so appearing/disappearing scrollbars cannot shift a table column.
  document.addEventListener('scroll', (event) => {
    const target = event.target === document ? document.documentElement : event.target;
    if (!(target instanceof Element)) return;
    clearTimeout(timers.get(target));
    target.setAttribute('data-scroll-active', '');
    timers.set(target, setTimeout(() => target.removeAttribute('data-scroll-active'), 800));
  }, true);
}
