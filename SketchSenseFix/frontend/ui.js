// ── ui.js ─────────────────────────────────────────────────────────────────────
// Stateless UI utilities: theme, sidebar, status pip, toast.

// ── Theme ─────────────────────────────────────────────────────────────────────
export function initTheme() {
  const toggle = document.getElementById('themeToggle');
  toggle.checked = document.documentElement.getAttribute('data-theme') !== 'light';

  toggle.addEventListener('change', () => {
    const isDark = toggle.checked;
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
let sidebarCollapsed = false;

export function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  document.getElementById('body').classList.toggle('sidebar-collapsed', sidebarCollapsed);
}

// ── Status pip ────────────────────────────────────────────────────────────────
export function setStatus(state, label) {
  const pip = document.getElementById('statusPip');
  pip.className = 'pip' + (state === 'live' ? ' live' : state === 'busy' ? ' busy' : '');
  document.getElementById('statusTxt').textContent = label;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
export function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 5000);
}

// ── Generic helpers ───────────────────────────────────────────────────────────
export function mkEl(tag, cls) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

export function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
