// ── messages.js ───────────────────────────────────────────────────────────────
// Message builders (user, AI, sys, thinking) and the sendChat action.
// Now passes state.currentSubject to /chat and /generate-image so the
// active persona is used for all follow-up interactions.

import { state }                          from './state.js';
import { showToast, mkEl, esc, nowTime }  from './ui.js';

const API_BASE = 'http://localhost:3001';

// Keywords that suggest the user wants a diagram or image generated
const IMAGE_TRIGGERS = /\b(draw|diagram|illustrate|sketch|show me|visuali[sz]e|generate.*image|image of|picture of|chart of|map of|with a diagram|with diagram|labeled diagram|label.{0,20}diagram|explain.{0,30}diagram|diagram.{0,30}explain)\b/i;

// ── Chat send ─────────────────────────────────────────────────────────────────
export async function sendChat() {
  const input   = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message || state.chatBusy || state.busy) return;

  state.chatBusy = true;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('btnSend').disabled = true;

  appendUser(message);
  const thinkEl = appendThinking();
  scrollMsgs();
  state.conversationHistory.push({ role: 'user', content: message });

  // Active subject — set by subject detection or manual override
  const subject = state.currentSubject || 'Other';

  const wantsImage = IMAGE_TRIGGERS.test(message);

  try {
    if (wantsImage) {
      // ── Image generation path ─────────────────────────────────────────────
      const res  = await fetch(`${API_BASE}/generate-image`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt: message, subject }),   // ← subject passed
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      const reply  = data.caption || 'Here\'s the diagram you asked for.';
      state.conversationHistory.push({ role: 'model', content: reply });
      thinkEl.remove();
      const genImg = data.imageBase64
        ? `data:${data.mimeType};base64,${data.imageBase64}`
        : null;
      appendAI(reply, null, genImg);

    } else {
      // ── Normal chat path ──────────────────────────────────────────────────
      const res  = await fetch(`${API_BASE}/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message,
          history: state.conversationHistory,
          subject,                                                // ← persona key
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      state.conversationHistory.push({ role: 'model', content: data.reply });
      thinkEl.remove();
      appendAI(data.reply);
    }
  } catch (e) {
    thinkEl.remove();
    showToast('Chat error: ' + e.message);
  } finally {
    state.chatBusy = false;
    document.getElementById('btnSend').disabled = false;
    scrollMsgs();
  }
}

// ── Message builders ──────────────────────────────────────────────────────────
export function appendUser(text) {
  clearEmpty();
  const el = mkEl('div', 'msg user');
  el.innerHTML = `
    <div class="msg-label">You <span class="msg-time">${nowTime()}</span></div>
    <div class="msg-bubble">${esc(text)}</div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
}

export function appendAI(markdown, frameDataUrl, generatedImageUrl) {
  clearEmpty();
  const el   = mkEl('div', 'msg ai');
  const html = marked.parse(markdown);

  // Persona label — show which tutor is responding
  const subject    = state.currentSubject || 'Other';
  const personaNames = {
    Math:            'Prof. Maya',
    Physics:         'Dr. Arun',
    Chemistry:       'Dr. Sofia',
    Biology:         'Dr. Kezia',
    ComputerScience: 'Alex',
    History:         'Prof. James',
    Literature:      'Prof. Claire',
    Economics:       'Prof. David',
    Other:           'Sam',
  };
  const tutorName = personaNames[subject] || 'Gemini';

  const genImgHtml = generatedImageUrl
    ? `<div class="msg-gen-img-wrap">
        <img class="msg-gen-img" src="${generatedImageUrl}" alt="Generated diagram" />
        <a class="msg-gen-img-dl" href="${generatedImageUrl}" download="diagram.png" title="Download">↓ Save</a>
       </div>`
    : '';

  el.innerHTML = `
    <div class="msg-label">${tutorName} <span class="msg-time">${nowTime()}</span></div>
    <div class="msg-bubble">${html}</div>
    ${genImgHtml}
    <button class="copy-btn" title="Copy response">Copy</button>`;
  document.getElementById('messages').appendChild(el);

  // Copy button
  const copyBtn = el.querySelector('.copy-btn');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(markdown).then(() => {
      copyBtn.textContent = 'Copied ✓';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 2000);
    }).catch(() => showToast('Copy failed'));
  });

  // Syntax highlighting
  el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));

  // LaTeX rendering
  renderMathInElement(el, {
    delimiters: [
      { left: '$$',  right: '$$',  display: true  },
      { left: '$',   right: '$',   display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true  },
    ],
    throwOnError: false,
  });

  scrollMsgs();
}

export function appendSys(text) {
  const el = mkEl('div', 'msg sys sys-temp');
  el.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
}

export function appendThinking() {
  const subject    = state.currentSubject || 'Other';
  const personaNames = {
    Math:            'Prof. Maya',
    Physics:         'Dr. Arun',
    Chemistry:       'Dr. Sofia',
    Biology:         'Dr. Kezia',
    ComputerScience: 'Alex',
    History:         'Prof. James',
    Literature:      'Prof. Claire',
    Economics:       'Prof. David',
    Other:           'Sam',
  };
  const tutorName = personaNames[subject] || 'Gemini';

  const el = mkEl('div', 'msg ai thinking');
  el.innerHTML = `
    <div class="msg-label">${tutorName}</div>
    <div class="msg-bubble">
      <span class="thinking-dots"><span>·</span><span>·</span><span>·</span></span>
    </div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
  return el;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function removeSysMsgs() {
  document.querySelectorAll('.sys-temp').forEach(e => e.remove());
}

export function clearAll() {
  state.conversationHistory = [];
  state.currentSubject      = 'Other';
  state.subjectManuallySet  = false;
  document.getElementById('messages').innerHTML = `
    <div class="empty-state" id="emptyState">
      <p class="empty-title">Ready when you are.</p>
      <p class="empty-hint">Start the camera, point it at your work,<br/>and hit <strong>Analyze</strong> — or ask anything below.</p>
    </div>`;
  // Reset badge
  const badge = document.getElementById('subjectBadge');
  if (badge) badge.remove();
  const dropdown = document.getElementById('subjectOverride');
  if (dropdown) dropdown.value = 'Auto';
}

function clearEmpty() {
  document.getElementById('emptyState')?.remove();
}

function scrollMsgs() {
  const m = document.getElementById('messages');
  m.scrollTop = m.scrollHeight;
}
