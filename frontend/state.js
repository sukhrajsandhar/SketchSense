// ── state.js ──────────────────────────────────────────────────────────────────
// Single source of truth for all shared app state.

export const state = {
  // Camera
  stream:              null,
  frameCount:          0,
  busy:                false,     // analyze is running
  chatBusy:            false,     // chat fetch is running
  hasAnalyzed:         false,

  // Conversation
  conversationHistory: [],

  // Subject detection
  currentSubject:      'Other',
  subjectManuallySet:  false,     // true when student picked from dropdown
};
