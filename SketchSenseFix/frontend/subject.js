// ── subject.js ────────────────────────────────────────────────────────────────
// Subject detection UI: badge display, colour coding, and manual override.
// Imported by camera.js (to update after analysis) and app.js (to expose
// overrideSubject globally for the inline HTML onchange handler).

import { state } from './state.js';

// ── Colour map ────────────────────────────────────────────────────────────────
const SUBJECT_COLORS = {
  Math:            '#6366f1',   // indigo
  Physics:         '#3b82f6',   // blue
  Chemistry:       '#10b981',   // emerald
  Biology:         '#84cc16',   // lime
  ComputerScience: '#f59e0b',   // amber
  History:         '#ef4444',   // red
  Literature:      '#ec4899',   // pink
  Economics:       '#8b5cf6',   // violet
  Other:           '#6b7280',   // gray
};

// Human-friendly display labels
const SUBJECT_LABELS = {
  ComputerScience: 'CS',
};

// ── Badge ─────────────────────────────────────────────────────────────────────
/**
 * Update (or create) the subject badge in the header.
 * @param {string} subject - One of the PERSONAS keys
 */
export function updateSubjectBadge(subject) {
  // Persist on shared state so chat endpoint can use the right persona
  state.currentSubject = subject;

  // Sync dropdown — Other = Auto in the UI
  const dropdown = document.getElementById('subjectOverride');
  if (dropdown) dropdown.value = subject === 'Other' ? 'Auto' : subject;

  // Don't show a badge for undetected subject
  if (subject === 'Other') {
    const existing = document.getElementById('subjectBadge');
    if (existing) existing.style.opacity = '0.35';
    return;
  }

  let badge = document.getElementById('subjectBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'subjectBadge';
    badge.className = 'subject-badge';
    const headerRight = document.querySelector('.header-right');
    const overrideWrap = document.getElementById('subjectOverrideWrap');
    if (overrideWrap) {
      headerRight.insertBefore(badge, overrideWrap);
    } else {
      headerRight.insertBefore(badge, headerRight.firstChild);
    }
  }

  badge.style.opacity = '1';
  const label = SUBJECT_LABELS[subject] || subject;
  const color = SUBJECT_COLORS[subject] || SUBJECT_COLORS.Other;

  badge.textContent = label;
  badge.style.setProperty('--subject-color', color);

  // Pop animation — remove then re-add class
  badge.classList.remove('subject-pop');
  void badge.offsetWidth;
  badge.classList.add('subject-pop');
}

// ── Manual override ───────────────────────────────────────────────────────────
/**
 * Called by the inline onchange on #subjectOverride.
 * Allows the student to correct a wrong detection.
 * @param {string} subject
 */
export function overrideSubject(subject) {
  if (!subject || subject === 'Auto') return;
  updateSubjectBadge(subject);
}

// ── Inject override dropdown into the DOM ─────────────────────────────────────
/**
 * Build and insert the subject override <select> next to the badge.
 * Call once from app.js after DOMContentLoaded.
 */
export function initSubjectOverride() {
  const subjects = [
    'Auto',
    'Math',
    'Physics',
    'Chemistry',
    'Biology',
    'ComputerScience',
    'History',
    'Literature',
    'Economics',
    'Other',
  ];

  const wrap = document.createElement('div');
  wrap.className = 'subject-override-wrap';
  wrap.id = 'subjectOverrideWrap';
  wrap.innerHTML = `
    <select id="subjectOverride" title="Override subject detection" onchange="overrideSubject(this.value)">
      ${subjects.map(s => `<option value="${s}">${s === 'ComputerScience' ? 'CS' : s}</option>`).join('')}
    </select>`;

  // Insert before model-tag: layout will be [badge] [override] [model-tag] [status] [theme]
  const headerRight = document.querySelector('.header-right');
  const modelTag = headerRight.querySelector('.model-tag');
  headerRight.insertBefore(wrap, modelTag);
}
