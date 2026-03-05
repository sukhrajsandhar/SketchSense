// ── camera.js ─────────────────────────────────────────────────────────────────
import { state }                               from './state.js';
import { setStatus, showToast, nowTime }       from './ui.js';
import { appendSys, appendAI, removeSysMsgs, appendStreamingAI } from './messages.js';
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

// ── Analyze (streaming) ───────────────────────────────────────────────────────
export async function analyzeFrame() {
  if (!state.stream || state.busy || state.chatBusy) return;
  state.busy = true;

  const video    = document.getElementById('video');
  const canvas   = document.getElementById('canvas');
  const ctx      = canvas.getContext('2d');
  const camScan  = document.getElementById('camScan');
  const camNudge = document.getElementById('camNudge');
  const btn      = document.getElementById('btnAnalyze');

  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Analyzing…';
  camScan.classList.add('active');
  setStatus('busy', 'Analyzing…');

  // Capture frame
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  // CSS mirrors the video display with scaleX(-1), so we must counter-mirror
  // the canvas capture to send Gemini the correct unflipped orientation
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();
  const b64 = canvas.toDataURL('image/jpeg', 0.88).split(',')[1];

  camNudge.classList.remove('visible');
  state.hasAnalyzed = true;
  state.frameCount++;
  document.getElementById('frameNum').textContent = state.frameCount;
  appendSys('Analyzing frame ' + state.frameCount + '…');

  try {
    const res = await fetch(`${API_BASE}/analyze`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ image: b64, subjectOverride: state.subjectManuallySet ? state.currentSubject : undefined }),
    });

    if (!res.ok) throw new Error('Server error ' + res.status);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';
    let   streamEl = null;   // the streaming message bubble
    let   fullText = '';

    removeSysMsgs();

    while (true) {
      const { done, value } = await reader.read();

      if (!done) {
        buffer += decoder.decode(value, { stream: true });
      }

      // Process all complete lines
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop(); // on done, process everything

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        let event;
        try { event = JSON.parse(raw); } catch (_) { continue; }

        if (event.subject !== undefined) {
          updateSubjectBadge(event.subject);
          state.conversationHistory.push({ role: 'user', content: '[Student showed a whiteboard/notebook frame]' });
        } else if (event.text !== undefined) {
          fullText += event.text;
          if (!streamEl) streamEl = appendStreamingAI();
          updateStreamingAI(streamEl, fullText);
        } else if (event.observation !== undefined || event.done !== undefined) {
          if (streamEl) finaliseStreamingAI(streamEl, fullText);
          state.conversationHistory.push({ role: 'model', content: fullText });
          if (window.mobileTab && window.innerWidth <= 700) window.mobileTab('chat');
        } else if (event.error) {
          throw new Error(event.error);
        }
      }

      // Guaranteed finalise when stream physically ends
      if (done) {
        if (streamEl && streamEl.classList.contains('streaming')) {
          finaliseStreamingAI(streamEl, fullText);
          state.conversationHistory.push({ role: 'model', content: fullText });
        }
        break;
      }
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

// ── Streaming bubble helpers (used only by camera.js) ─────────────────────────
function updateStreamingAI(el, markdown) {
  const bubble = el.querySelector('.msg-bubble');
  if (!bubble) return;
  // Plain text while streaming — smooth, no layout thrash
  bubble.innerHTML = '<pre class="stream-plain">' + markdown.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre><span class="stream-cursor"></span>';
  // Only scroll if user is near the bottom
  const msgs = document.getElementById('messages');
  const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120;
  if (nearBottom) msgs.scrollTop = msgs.scrollHeight;
}

function finaliseStreamingAI(el, markdown) {
  el.classList.remove('streaming');

  // Full proper markdown render — replaces plain text stream
  const bubble = el.querySelector('.msg-bubble');
  if (bubble) {
    bubble.innerHTML = marked.parse(markdown);
    // Remove any leftover streaming cursor
    bubble.querySelectorAll('.stream-cursor').forEach(c => c.remove());
    bubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    renderMathInElement(bubble, {
      delimiters: [
        { left: '$$', right: '$$', display: true  },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true  },
      ],
      throwOnError: false,
    });
  }

  // Add copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.title = 'Copy response';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(markdown).then(() => {
      copyBtn.textContent = 'Copied ✓';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
    });
  });
  el.appendChild(copyBtn);

  // Scroll to show final answer
  const msgs = document.getElementById('messages');
  msgs.scrollTop = msgs.scrollHeight;
}
