// ── app.js ────────────────────────────────────────────────────────────────────
// Entry point — wires up all modules and exposes globals for HTML onclick handlers.

import { initTheme, toggleSidebar }               from './ui.js';
import { startCamera, stopCamera, analyzeFrame }  from './camera.js';
import { sendChat, clearAll }                     from './messages.js';
import { initSubjectOverride, overrideSubject }   from './subject.js';
import { toggleVoice, toggleTTS, stopSpeaking, setVolume, startLiveWithCamera, stopLiveSession } from './voice.js';
import { state } from './state.js';

// ── Init ──────────────────────────────────────────────────────────────────────

marked.setOptions({ breaks: true, gfm: true });
initTheme();
initSubjectOverride();   // inject subject dropdown into header

// ── Mode switching ────────────────────────────────────────────────────────────

let currentMode = 'analyze';

window.setMode = async function(mode) {
  if (mode === currentMode) return;
  currentMode = mode;

  const sidebar          = document.getElementById('sidebar');
  const analyzeControls  = document.getElementById('analyzeControls');
  const liveControls     = document.getElementById('liveControls');
  const modeAnalyzeBtn   = document.getElementById('modeAnalyzeBtn');
  const modeLiveBtn      = document.getElementById('modeLiveBtn');
  const frameCounterWrap = document.getElementById('frameCounterWrap');
  const camThumbWrap     = document.getElementById('camThumbWrap');
  const camNudge         = document.getElementById('camNudge');
  const pipWrap          = document.getElementById('pipWrap');

  if (mode === 'live') {
    sidebar.dataset.mode = 'live';
    modeAnalyzeBtn.classList.remove('active');
    modeLiveBtn.classList.add('active');
    analyzeControls.style.display  = 'none';
    liveControls.style.display     = 'flex';
    frameCounterWrap.style.display = 'none';
    camThumbWrap.style.display     = 'none';
    camNudge.classList.remove('visible');
    if (pipWrap) pipWrap.classList.remove('active'); // hide PiP, video is in sidebar now

    // Auto-start camera if not already running
    if (!state.stream) await startCamera();

  } else {
    // Switching back to analyze — stop live session if running
    stopLiveSession();

    sidebar.dataset.mode = 'analyze';
    modeAnalyzeBtn.classList.add('active');
    modeLiveBtn.classList.remove('active');
    analyzeControls.style.display  = 'flex';
    liveControls.style.display     = 'none';
    frameCounterWrap.style.display = '';
    // Show nudge again if camera is running
    if (state.stream) camNudge.classList.add('visible');
  }
};

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
