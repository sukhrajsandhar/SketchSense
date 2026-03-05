// ── messages.js ───────────────────────────────────────────────────────────────
import { state }                         from './state.js';
import { showToast, mkEl, esc, nowTime } from './ui.js';

const API_BASE = 'http://localhost:3001';

const IMAGE_TRIGGERS = /\b(draw|diagram|illustrate|sketch|show me|visuali[sz]e|generate.*image|image of|picture of|chart of|map of|with a diagram|with diagram|labeled diagram|label.{0,20}diagram|explain.{0,30}diagram|diagram.{0,30}explain)\b/i;

// Persona name map
const PERSONA_NAMES = {
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

function tutorName() {
  return PERSONA_NAMES[state.currentSubject] || 'Gemini';
}

// ── Chat send (streaming) ─────────────────────────────────────────────────────
export async function sendChat() {
  const input   = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message || state.chatBusy || state.busy) return;

  state.chatBusy = true;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('btnSend').disabled = true;

  appendUser(message);
  scrollMsgs();
  state.conversationHistory.push({ role: 'user', content: message });

  const subject    = state.currentSubject || 'Other';
  const wantsImage = IMAGE_TRIGGERS.test(message);

  try {
    if (wantsImage) {
      // Image generation — not streamed
      const thinkEl = appendThinking();
      const res  = await fetch(`${API_BASE}/generate-image`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt: message, subject }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      const reply  = data.caption || 'Here\'s the diagram you asked for.';
      state.conversationHistory.push({ role: 'model', content: reply });
      thinkEl.remove();
      const genImg = data.imageBase64 ? `data:${data.mimeType};base64,${data.imageBase64}` : null;
      appendAI(reply, null, genImg);

    } else {
      // Streaming chat
      const streamEl = appendStreamingAI();
      let fullReply  = '';

      const res = await fetch(`${API_BASE}/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message, history: state.conversationHistory, subject }),
      });

      if (!res.ok) throw new Error('Server error ' + res.status);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { done, value } = await reader.read();

        if (!done) {
          buffer += decoder.decode(value, { stream: true });
        }

        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          let event;
          try { event = JSON.parse(raw); } catch (_) { continue; }
          if (event.subject !== undefined) {
            state.currentSubject = event.subject;
            import('./subject.js').then(m => m.updateSubjectBadge(event.subject));
            // Create the bubble NOW with the correct persona name
            if (!streamEl) streamEl = appendStreamingAI(null); // will be renamed below
            updateStreamingLabel(streamEl, event.subject);
          } else if (event.text !== undefined) {
            // Create bubble on first chunk if subject event didn't fire yet
            if (!streamEl) streamEl = appendStreamingAI();
            fullReply += event.text;
            updateStreamingBubble(streamEl, fullReply);
          } else if (event.reply !== undefined || event.observation !== undefined) {
            finaliseStreamingBubble(streamEl, fullReply);
            state.conversationHistory.push({ role: 'model', content: fullReply });
          } else if (event.error) {
            throw new Error(event.error);
          }
        }

        // Guaranteed finalise when stream physically ends
        if (done) {
          if (streamEl && streamEl.classList.contains('streaming')) {
            finaliseStreamingBubble(streamEl, fullReply);
            state.conversationHistory.push({ role: 'model', content: fullReply });
          }
          break;
        }
      }
    }
  } catch (e) {
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

// Creates an empty streaming bubble with a blinking cursor
export function appendStreamingAI(nameOverride) {
  clearEmpty();
  const el = mkEl('div', 'msg ai streaming');
  const name = nameOverride || tutorName();
  el.innerHTML = `
    <div class="msg-label">${name} <span class="msg-time">${nowTime()}</span></div>
    <div class="msg-bubble"><span class="stream-cursor"></span></div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
  return el;
}

// Update the label on an existing streaming bubble (called when subject event arrives)
export function updateStreamingLabel(el, subject) {
  const PERSONA_NAMES = {
    Math: 'Prof. Maya', Physics: 'Dr. Arun', Chemistry: 'Dr. Sofia',
    Biology: 'Dr. Kezia', ComputerScience: 'Alex', History: 'Prof. James',
    Literature: 'Prof. Claire', Economics: 'Prof. David', Other: 'Sam',
  };
  const label = el.querySelector('.msg-label');
  if (label) {
    const time = label.querySelector('.msg-time');
    label.textContent = PERSONA_NAMES[subject] || 'Sam';
    if (time) label.appendChild(time);
  }
}

// Update streaming bubble — plain text while streaming to avoid layout thrash
function updateStreamingBubble(el, markdown) {
  const bubble = el.querySelector('.msg-bubble');
  if (!bubble) return;
  // Show as preformatted plain text while streaming — fast and smooth
  bubble.innerHTML = '<pre class="stream-plain">' + esc(markdown) + '</pre><span class="stream-cursor"></span>';
  scrollMsgs();
}

// Finalise — remove cursor, add copy button
function finaliseStreamingBubble(el, markdown) {
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
    }).catch(() => showToast('Copy failed'));
  });
  el.appendChild(copyBtn);
  scrollMsgs();
}

export function appendAI(markdown, frameDataUrl, generatedImageUrl) {
  clearEmpty();
  const el   = mkEl('div', 'msg ai');
  const html = marked.parse(markdown);

  const genImgHtml = generatedImageUrl
    ? `<div class="msg-gen-img-wrap">
        <img class="msg-gen-img" src="${generatedImageUrl}" alt="Generated diagram" />
        <a class="msg-gen-img-dl" href="${generatedImageUrl}" download="diagram.png" title="Download">↓ Save</a>
       </div>`
    : '';

  el.innerHTML = `
    <div class="msg-label">${tutorName()} <span class="msg-time">${nowTime()}</span></div>
    <div class="msg-bubble">${html}</div>
    ${genImgHtml}
    <button class="copy-btn" title="Copy response">Copy</button>`;
  document.getElementById('messages').appendChild(el);

  const copyBtn = el.querySelector('.copy-btn');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(markdown).then(() => {
      copyBtn.textContent = 'Copied ✓';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
    }).catch(() => showToast('Copy failed'));
  });

  el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  renderMathInElement(el, {
    delimiters: [
      { left: '$$', right: '$$', display: true  },
      { left: '$',  right: '$',  display: false },
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
  const el = mkEl('div', 'msg ai thinking');
  el.innerHTML = `
    <div class="msg-label">${tutorName()}</div>
    <div class="msg-bubble">
      <span class="thinking-dots"><span>·</span><span>·</span><span>·</span></span>
    </div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
  return el;
}

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
  const badge = document.getElementById('subjectBadge');
  if (badge) badge.remove();
  const dropdown = document.getElementById('subjectOverride');
  if (dropdown) dropdown.value = 'Auto';
}

function clearEmpty() { document.getElementById('emptyState')?.remove(); }
function scrollMsgs() {
  const m = document.getElementById('messages');
  // Only auto-scroll if user is within 120px of the bottom
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  if (nearBottom) m.scrollTop = m.scrollHeight;
}
