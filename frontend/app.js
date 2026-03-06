// ── app.js ────────────────────────────────────────────────────────────────────
// Entry point — wires up all modules and exposes globals for HTML onclick handlers.

import { initTheme, toggleSidebar }               from './ui.js';
import { startCamera, stopCamera, analyzeFrame }  from './camera.js';
import { sendChat, clearAll }                     from './messages.js';
import { initSubjectOverride, overrideSubject }   from './subject.js';
import { toggleVoice, toggleTTS, stopSpeaking, setVolume, toggleLiveCamera } from './voice.js';

// ── Init ──────────────────────────────────────────────────────────────────────

marked.setOptions({ breaks: true, gfm: true });
initTheme();
initSubjectOverride();   // inject subject dropdown into header

// ── Expose globals for inline HTML onclick / oninput handlers ─────────────────

window.toggleSidebar    = toggleSidebar;
window.startCamera      = startCamera;
window.stopCamera       = stopCamera;
window.analyzeFrame     = analyzeFrame;
window.sendChat         = sendChat;
window.clearAll         = clearAll;
window.overrideSubject  = overrideSubject;
window.toggleVoice      = toggleVoice;
window.toggleTTS        = toggleTTS;
window.stopSpeaking     = stopSpeaking;
window.setVolume        = setVolume;
window.toggleLiveCamera = toggleLiveCamera;

// ── Mobile tab switching ──────────────────────────────────────────────────────

window.mobileTab = function (tab) {
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

// Show pip dot on mobile camera tab when stream is live
const _origStart = window.startCamera;
window.startCamera = async function () {
  await _origStart();
  document.getElementById('tabPip')?.classList.add('visible');
};
const _origStop = window.stopCamera;
window.stopCamera = function () {
  _origStop();
  document.getElementById('tabPip')?.classList.remove('visible');
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
    e.preventDefault(); analyzeFrame();
  }
  if (e.key === '[' && !e.target.matches('textarea,input,select')) {
    toggleSidebar();
  }
});
