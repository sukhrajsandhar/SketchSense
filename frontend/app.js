// ── app.js ────────────────────────────────────────────────────────────────────
// Entry point. Imports all modules and wires up event listeners + global refs.

import { initTheme, toggleSidebar }          from './ui.js';
import { startCamera, stopCamera, analyzeFrame } from './camera.js';
import { sendChat, clearAll }                from './messages.js';
import { initSubjectOverride, overrideSubject } from './subject.js';

marked.setOptions({ breaks: true, gfm: true });

// ── Init ──────────────────────────────────────────────────────────────────────
initTheme();
initSubjectOverride();   // inject the subject dropdown into the header

// ── Expose to inline HTML onclick handlers ────────────────────────────────────
window.toggleSidebar  = toggleSidebar;
window.startCamera    = startCamera;
window.stopCamera     = stopCamera;
window.analyzeFrame   = analyzeFrame;
window.sendChat       = sendChat;
window.clearAll       = clearAll;
window.overrideSubject = overrideSubject;   // called by the dropdown onchange

// ── Mobile tab switching ──────────────────────────────────────────────────────
window.mobileTab = function(tab) {
  const body      = document.getElementById('body');
  const tabCamera = document.getElementById('tabCamera');
  const tabChat   = document.getElementById('tabChat');
  if (tab === 'chat') {
    body.classList.add('mobile-chat');
    tabChat.classList.add('active');
    tabCamera.classList.remove('active');
  } else {
    body.classList.remove('mobile-chat');
    tabCamera.classList.add('active');
    tabChat.classList.remove('active');
  }
};

// Show pip on camera tab when stream is live
const _origStart = window.startCamera;
window.startCamera = async function() {
  await _origStart();
  const pip = document.getElementById('tabPip');
  if (pip) pip.classList.add('visible');
};
const _origStop = window.stopCamera;
window.stopCamera = function() {
  _origStop();
  const pip = document.getElementById('tabPip');
  if (pip) pip.classList.remove('visible');
};

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
const chatInput = document.getElementById('chatInput');

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

chatInput.addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
});

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.target.matches('button,textarea,input,select')) {
    e.preventDefault();
    analyzeFrame();
  }
  if (e.key === '[' && !e.target.matches('textarea,input,select')) {
    toggleSidebar();
  }
});
