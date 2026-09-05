// Theme (Settings > Appearance): applied at the top level, before the async
// IIFE in renderer.js does anything else, so there's no flash of the wrong
// theme while backend calls are still in flight. "System" (the default) just
// means no data-theme attribute -- style.css's prefers-color-scheme media
// query is then the only source of truth; Light/Dark set the attribute,
// which wins over that media query regardless of the OS setting (see the
// :root[data-theme] rules in style.css).
//
// Issue #500: extracted from renderer.js -- loaded in its exact original
// script position (immediately before renderer.js) so this still runs at
// the same point in page load it always did.
const THEME_STORAGE_KEY = 'manaTheme';
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark' || choice === 'high-contrast') {
    document.documentElement.setAttribute('data-theme', choice);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.querySelectorAll('#themeToggle button[data-theme-choice]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeChoice === choice);
  });
}
applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'system');
document.getElementById('themeToggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-theme-choice]');
  if (!btn) return;
  const choice = btn.dataset.themeChoice;
  localStorage.setItem(THEME_STORAGE_KEY, choice);
  applyTheme(choice);
});
