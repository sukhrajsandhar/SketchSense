// ── messages.js ───────────────────────────────────────────────────────────────
// THE single rendering system for all messages — camera, chat, and voice.
// camera.js and voice.js both call these shared functions.

import { state }                         from './state.js';
import { showToast, mkEl, esc, nowTime } from './ui.js';
import { IMAGE_TRIGGERS, PERSONA_NAMES } from './prompts.js';
import { attachExportBtn }               from './export.js';

const API_BASE = 'http://localhost:3001';

// ── Internal helpers ──────────────────────────────────────────────────────────

export function tutorName() {
  return PERSONA_NAMES[state.currentSubject] || 'Sam';
}

export function clearEmpty() {
  document.getElementById('emptyState')?.remove();
}

export function scrollMsgs() {
  const m = document.getElementById('messages');
  if (m && m.scrollHeight - m.scrollTop - m.clientHeight < 160) {
    m.scrollTop = m.scrollHeight;
  }
}

function toPlainText(md) {
  return md
    .replace(/<details>[\s\S]*?<\/details>/gi, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, '')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\$\$(.+?)\$\$/gs, '$1')
    .replace(/\$(.+?)\$/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^---+$/gm, '')
    .replace(/💡\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderMath(el) {
  if (window.renderMathInElement) {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true  },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true  },
      ],
      throwOnError: false,
    });
  }
}

// ── SHARED: Create streaming bubble ──────────────────────────────────────────
// Used by camera.js, sendChat(), and voice.js
//   nameOverride — override label (e.g. '📄 Live Document')
//   icon         — emoji appended to label (e.g. '🎙' for voice)

export function appendStreamingAI(nameOverride, icon) {
  clearEmpty();
  const el   = mkEl('div', 'msg ai streaming');
  const name = (nameOverride || tutorName()) + (icon ? ' ' + icon : '');
  el.innerHTML = `
    <div class="msg-label">${esc(name)} <span class="msg-time">${nowTime()}</span></div>
    <div class="msg-bubble"><span class="stream-cursor"></span></div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
  return el;
}

// ── SHARED: Update label on a streaming bubble ────────────────────────────────
// Called when a subject SSE event arrives mid-stream (chat + camera)

export function updateStreamingLabel(el, subject) {
  const label = el.querySelector('.msg-label');
  if (!label) return;
  const time = label.querySelector('.msg-time');
  label.textContent = PERSONA_NAMES[subject] || 'Sam';
  if (time) label.appendChild(time);
}

// ── SHARED: Update bubble text while streaming ────────────────────────────────
// Plain text for performance — rendered to markdown on finalise

export function updateStreamingBubble(el, text) {
  const bubble = el.querySelector('.msg-bubble');
  if (!bubble) return;
  bubble.innerHTML = '<pre class="stream-plain">' + esc(text) + '</pre><span class="stream-cursor"></span>';
  scrollMsgs();
}

// ── SHARED: Finalise a streaming bubble ───────────────────────────────────────
// Renders markdown + math + code, adds copy button + export dropdown.
// Options:
//   skipExport {bool}   — omit export dropdown (voice bubbles)
//   plainText  {bool}   — copy button copies plain text (voice bubbles)
//   docCard    {bool}   — styles as a doc card (live documents)

export function finaliseStreamingBubble(el, markdown, opts = {}) {
  el.classList.remove('streaming');

  // Detect and strip <details> block (analyze responses embed "what I saw" here)
  const detailsMatch = markdown.match(/<details>[\s\S]*?<\/details>/i);
  const clean        = markdown.replace(/<details>[\s\S]*?<\/details>/i, '').trim();

  const bubbleSel = opts.docCard ? '.doc-body' : '.msg-bubble';
  const bubble = el.querySelector(bubbleSel) || el.querySelector('.msg-bubble');
  if (bubble) {
    bubble.innerHTML = marked.parse(clean);
    bubble.querySelectorAll('.stream-cursor').forEach(c => c.remove());
    bubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    renderMath(bubble);
  }

  // ── Copy button ─────────────────────────────────────────────────────────────
  const topRight = document.createElement('div');
  topRight.className = 'msg-top-right';

  const copyBtn = document.createElement('button');
  copyBtn.className   = 'copy-btn';
  copyBtn.title       = 'Copy response';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    const text = opts.plainText ? clean : toPlainText(clean);
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied ✓';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
    }).catch(() => showToast('Copy failed'));
  });
  topRight.appendChild(copyBtn);
  el.appendChild(topRight);

  // ── Export dropdown (camera + chat only) ────────────────────────────────────
  if (!opts.skipExport) {
    attachExportBtn(el);
  }

  // ── "👁 what I saw" footnote (analyze responses only) ──────────────────────
  if (detailsMatch) {
    const seenText = detailsMatch[0]
      .replace(/<summary>.*?<\/summary>/i, '')
      .replace(/<\/?details>/gi, '')
      .trim();
    if (seenText) {
      const footnote = document.createElement('div');
      footnote.className = 'msg-seen-footnote';
      footnote.innerHTML = `<span class="msg-seen-toggle">👁 what I saw</span><span class="msg-seen-text">${esc(seenText)}</span>`;
      footnote.querySelector('.msg-seen-toggle').addEventListener('click', () => {
        footnote.classList.toggle('expanded');
      });
      el.appendChild(footnote);
    }
  }

  scrollMsgs();
}

// ── Static message builders ───────────────────────────────────────────────────

export function appendUser(text) {
  clearEmpty();
  const el = mkEl('div', 'msg user');
  el.innerHTML = `
    <div class="msg-label">You <span class="msg-time">${nowTime()}</span></div>
    <div class="msg-bubble">${esc(text)}</div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
}

// Used for image-generation results (appendAI with optional generated image)
export function appendAI(markdown, _frameDataUrl, generatedImageUrl) {
  clearEmpty();
  const el   = mkEl('div', 'msg ai');
  const html = marked.parse(markdown);

  const genHtml = generatedImageUrl
    ? `<div class="msg-gen-img-wrap">
        <img class="msg-gen-img" src="${generatedImageUrl}" alt="Generated diagram" />
        <a class="msg-gen-img-dl" href="${generatedImageUrl}" download="diagram.png" title="Download">↓ Save</a>
       </div>`
    : '';

  el.innerHTML = `
    <div class="msg-label">${esc(tutorName())} <span class="msg-time">${nowTime()}</span></div>
    <div class="msg-bubble">${html}</div>
    ${genHtml}`;

  // Copy button
  const topRight = document.createElement('div');
  topRight.className = 'msg-top-right';
  const copyBtn = document.createElement('button');
  copyBtn.className   = 'copy-btn';
  copyBtn.title       = 'Copy response';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(toPlainText(markdown)).then(() => {
      copyBtn.textContent = 'Copied ✓';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
    }).catch(() => showToast('Copy failed'));
  });
  topRight.appendChild(copyBtn);
  el.appendChild(topRight);
  attachExportBtn(el);

  document.getElementById('messages').appendChild(el);
  el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  renderMath(el);
  scrollMsgs();
}

export function appendSys(text) {
  const el = mkEl('div', 'msg sys sys-temp');
  el.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
}

// For voice live-status messages (tagged so stopLive() can remove them)
export function appendSysLive(text) {
  clearEmpty();
  const el = mkEl('div', 'msg sys live-status');
  el.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
  document.getElementById('messages').appendChild(el);
  scrollMsgs();
}

export function appendThinking() {
  clearEmpty();
  const el = mkEl('div', 'msg ai thinking');
  el.innerHTML = `
    <div class="msg-label">${esc(tutorName())}</div>
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
  document.getElementById('subjectBadge')?.remove();
  const dd = document.getElementById('subjectOverride');
  if (dd) dd.value = 'Auto';
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
  state.conversationHistory.push({ role: 'user', content: message });

  const subject    = state.currentSubject || 'Other';
  const wantsImage = IMAGE_TRIGGERS.test(message);

  try {
    if (wantsImage) {
      const thinkEl = appendThinking();
      const res  = await fetch(`${API_BASE}/generate-image`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt: message, subject }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      const reply  = data.caption || "Here's the diagram you asked for.";
      state.conversationHistory.push({ role: 'model', content: reply });
      thinkEl.remove();
      const genImg = data.imageBase64 ? `data:${data.mimeType};base64,${data.imageBase64}` : null;
      appendAI(reply, null, genImg);

    } else {
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
        if (!done) buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(raw); } catch (_) { continue; }

          if (ev.subject !== undefined) {
            state.currentSubject = ev.subject;
            import('./subject.js').then(m => m.updateSubjectBadge(ev.subject));
            updateStreamingLabel(streamEl, ev.subject);
          } else if (ev.text !== undefined) {
            fullReply += ev.text;
            updateStreamingBubble(streamEl, fullReply);
          } else if (ev.reply !== undefined || ev.observation !== undefined) {
            finaliseStreamingBubble(streamEl, fullReply);
            state.conversationHistory.push({ role: 'model', content: fullReply });
          } else if (ev.error) {
            throw new Error(ev.error);
          }
        }

        if (done) {
          if (streamEl.classList.contains('streaming')) {
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
