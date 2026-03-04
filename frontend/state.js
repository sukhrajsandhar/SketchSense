// ── state.js ──────────────────────────────────────────────────────────────────
// Single source of truth for all shared app state.

export const state = {
  stream:              null,
  frameCount:          0,
  busy:                false,
  chatBusy:            false,
  conversationHistory: [],
  hasAnalyzed:         false,

  // ── Subject detection ──────────────────────────────────────────────────────
  // Set by /analyze response or manual override in subject.js
  currentSubject:     'Other',
  // True when the student has manually selected a subject via the dropdown
  subjectManuallySet: false,
};
