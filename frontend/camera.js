// ── camera.js ─────────────────────────────────────────────────────────────────
// Camera lifecycle: start, stop, capture frame, and send for analysis.
// Now includes subject detection: reads detected subject from /analyze response
// and updates the UI badge via subject.js.

import { state }                               from './state.js';
import { setStatus, showToast, nowTime }       from './ui.js';
import { appendSys, appendAI, removeSysMsgs } from './messages.js';
import { updateSubjectBadge }                  from './subject.js';

const API_BASE = 'http://localhost:3001';

// ── Start ─────────────────────────────────────────────────────────────────────
export async function startCamera() {
  const video       = document.getElementById('video');
  const camIdle     = document.getElementById('camIdle');
  const camBrackets = document.getElementById('camBrackets');
  const camNudge    = document.getElementById('camNudge');

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = state.stream;
    video.classList.add('active');
    camIdle.classList.add('gone');
    camBrackets.classList.add('show');
    camNudge.classList.add('visible');

    setStatus('live', 'Live');
    document.getElementById('btnStart').disabled   = true;
    document.getElementById('btnStop').disabled    = false;
    document.getElementById('btnAnalyze').disabled = false;
  } catch (e) {
    showToast('Camera error: ' + e.message);
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────
export function stopCamera() {
  const video       = document.getElementById('video');
  const camIdle     = document.getElementById('camIdle');
  const camBrackets = document.getElementById('camBrackets');
  const camNudge    = document.getElementById('camNudge');

  state.stream?.getTracks().forEach(t => t.stop());
  state.stream      = null;
  video.srcObject   = null;
  video.classList.remove('active');
  camIdle.classList.remove('gone');
  camBrackets.classList.remove('show');
  camNudge.classList.remove('visible');
  state.hasAnalyzed     = false;
  state.currentSubject  = 'Other';

  setStatus('off', 'Camera offline');
  document.getElementById('btnStart').disabled   = false;
  document.getElementById('btnStop').disabled    = true;
  document.getElementById('btnAnalyze').disabled = true;
}

// ── Analyze ───────────────────────────────────────────────────────────────────
export async function analyzeFrame() {
  if (!state.stream || state.busy || state.chatBusy) return;
  state.busy = true;

  const video        = document.getElementById('video');
  const canvas       = document.getElementById('canvas');
  const ctx          = canvas.getContext('2d');
  const camScan      = document.getElementById('camScan');
  const camNudge     = document.getElementById('camNudge');
  const btn          = document.getElementById('btnAnalyze');

  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Analyzing…';
  camScan.classList.add('active');
  setStatus('busy', 'Analyzing…');

  // Capture frame — CSS handles the mirror via scaleX(-1), so draw normally
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  const b64     = dataUrl.split(',')[1];

  camNudge.classList.remove('visible');
  state.hasAnalyzed = true;
  state.frameCount++;
  document.getElementById('frameNum').textContent = state.frameCount;
  appendSys('Analyzing frame ' + state.frameCount + '…');

  try {
    // Pass subjectOverride if student manually selected one
    const subjectOverride = state.currentSubject !== 'Other' && state.subjectManuallySet
      ? state.currentSubject
      : undefined;

    const res  = await fetch(`${API_BASE}/analyze`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ image: b64, subjectOverride }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    // ── Update subject badge with detected (or overridden) subject ────────────
    if (data.subject) {
      updateSubjectBadge(data.subject);
    }

    state.conversationHistory.push({ role: 'user',  content: '[Student showed a whiteboard/notebook frame]' });
    state.conversationHistory.push({ role: 'model', content: data.observation });

    removeSysMsgs();
    appendAI(data.observation, dataUrl);

    // On mobile, auto-switch to chat tab after analysis
    if (window.mobileTab && window.innerWidth <= 700) {
      window.mobileTab('chat');
    }
  } catch (e) {
    removeSysMsgs();
    showToast('Error: ' + e.message);
  } finally {
    state.busy = false;
    document.getElementById('camScan').classList.remove('active');
    setStatus('live', 'Live');

    btn.classList.remove('loading');
    btn.classList.add('done');
    btn.textContent = 'Done ✓';
    setTimeout(() => {
      btn.classList.remove('done');
      btn.textContent = 'Analyze';
      btn.disabled    = false;
    }, 1400);
  }
}
