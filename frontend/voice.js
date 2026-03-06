// ── voice.js ──────────────────────────────────────────────────────────────────
// Gemini Live API — real-time voice + video tutoring.
// Subject is set exclusively via the dropdown — no auto-detection.

import { state }           from './state.js';
import { showToast }       from './ui.js';
import { DOC_TRIGGERS, liveDocPrompt, PERSONA_NAMES } from './prompts.js';
import {
  clearEmpty, scrollMsgs,
  appendStreamingAI, updateStreamingBubble, updateStreamingBubbleMarkdown, finaliseStreamingBubble,
  appendSysLive,
} from './messages.js';

const WS_URL   = 'ws://localhost:3001/live';
const CHAT_URL = 'http://localhost:3001/chat';
const IN_RATE   = 16000;
const OUT_RATE  = 24000;
const CHUNK_SZ  = 2048;
const VIDEO_FPS = 4;
const JPEG_Q    = 0.6;

// ── Module state ──────────────────────────────────────────────────────────────

let ws           = null;
let micCtx       = null;
let playCtx      = null;
let gainNode     = null;
let analyserNode = null;
let processor    = null;
let micStream    = null;
let isLive       = false;
let ttsEnabled   = true;
let volume       = 1.0;
let nextPlayTime = 0;

// Video
let vidStream    = null;
let vidInterval  = null;
let vidCanvas    = null;
let vidCtx2d     = null;
let videoEnabled = false;

// The subject this session was started with — read from dropdown at session start.
// To change persona: end session, pick subject from dropdown, start again.
let sessionSubject = 'Other';

// Active streaming bubbles
let currentAIBubble   = null;
let currentUserBubble = null;
let aiAccum           = '';
let userAccum         = '';

// Active audio sources — tracked so we can stop them all on interrupt
const activeSources  = new Set();
let   audioMuted     = false; // when true, incoming audio chunks are dropped
let   skipTurn       = false; // when true, discard transcript/audio until next turn_complete

// VAD
let vadFrames        = 0;
const VAD_THRESH     = 0.015;
const VAD_FRAMES_REQ = 4;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Join transcript chunks with a space only when needed.
// Gemini Live sends chunks that sometimes have leading/trailing spaces and
// sometimes don't — naively concatenating causes "wordsmashed" or "word  doubled".
function joinChunk(acc, chunk) {
  if (!acc) return chunk;
  const needsSpace = acc.length > 0
    && !/\s$/.test(acc)        // acc doesn't end with whitespace
    && !/^[\s.,!?;:)]/.test(chunk); // chunk doesn't start with space or punctuation
  return acc + (needsSpace ? ' ' : '') + chunk;
}

function voiceTutorName() {
  return PERSONA_NAMES[sessionSubject] || 'Sam';
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function toggleVoice() {
  if (isLive) stopLive(); else await startLive();
}

export function toggleTTS() {
  ttsEnabled = !ttsEnabled;
  if (gainNode) gainNode.gain.value = ttsEnabled ? volume : 0;
  const btn = document.getElementById('btnTTS');
  if (btn) {
    btn.classList.toggle('tts-on',  ttsEnabled);
    btn.classList.toggle('tts-off', !ttsEnabled);
    btn.title = ttsEnabled ? 'Mute AI voice' : 'Unmute AI voice';
  }
}

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, parseFloat(v)));
  if (gainNode && ttsEnabled) gainNode.gain.value = volume;
}

export function stopSpeaking()       { interruptPlayback(); }
export async function startLiveWithCamera() { await startLive(); }
export function stopLiveSession()    { if (isLive) stopLive(); }

// ── Live camera ───────────────────────────────────────────────────────────────

async function startVideo() {
  try {
    const sidebarVideo = document.getElementById('video');
    if (!sidebarVideo || !sidebarVideo.srcObject) return;
    vidStream    = sidebarVideo.srcObject;
    vidCanvas        = document.createElement('canvas');
    vidCanvas.width  = 640;
    vidCanvas.height = 480;
    vidCtx2d         = vidCanvas.getContext('2d');
    videoEnabled     = true;
    if (isLive && ws?.readyState === WebSocket.OPEN) startFrameLoop();
  } catch (e) {
    showToast('Camera error: ' + e.message);
  }
}

function stopVideo() {
  stopFrameLoop();
  vidStream = null; videoEnabled = false; vidCanvas = null; vidCtx2d = null;
}

function startFrameLoop() {
  if (vidInterval) return;
  const sidebarVideo = document.getElementById('video');
  vidInterval = setInterval(() => {
    if (!vidCtx2d || !vidCanvas || ws?.readyState !== WebSocket.OPEN) return;
    const src = sidebarVideo && sidebarVideo.videoWidth > 0 ? sidebarVideo : null;
    if (!src) return;
    vidCanvas.width  = src.videoWidth  || 640;
    vidCanvas.height = src.videoHeight || 480;
    vidCtx2d.save();
    vidCtx2d.translate(vidCanvas.width, 0);
    vidCtx2d.scale(-1, 1);
    vidCtx2d.drawImage(src, 0, 0);
    vidCtx2d.restore();
    const b64 = vidCanvas.toDataURL('image/jpeg', JPEG_Q).split(',')[1];
    if (b64) ws.send(JSON.stringify({ type: 'video', data: b64 }));
  }, 1000 / VIDEO_FPS);
}

function stopFrameLoop() {
  if (vidInterval) { clearInterval(vidInterval); vidInterval = null; }
}

// ── Sidebar UI ────────────────────────────────────────────────────────────────

function setLiveSessionState(s) {
  const dot     = document.getElementById('liveStatusDot');
  const label   = document.getElementById('liveStatusLabel');
  const btn     = document.getElementById('btnLiveSession');
  const overlay = document.getElementById('liveOverlay');
  const micSvg  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;
  const xSvg    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  if (s === 'live') {
    dot?.classList.add('active');
    if (label) label.textContent = 'Session active';
    if (btn)   { btn.disabled = false; btn.classList.add('btn-live-active'); btn.innerHTML = `${xSvg} End Session`; }
    overlay?.classList.add('active');
  } else if (s === 'connecting') {
    dot?.classList.remove('active'); dot?.classList.add('connecting');
    if (label) label.textContent = 'Connecting…';
    if (btn)   { btn.disabled = true; }
    overlay?.classList.remove('active');
  } else {
    dot?.classList.remove('active', 'connecting');
    if (label) label.textContent = 'Ready to connect';
    if (btn)   { btn.disabled = false; btn.classList.remove('btn-live-active'); btn.innerHTML = `${micSvg} Start Session`; }
    overlay?.classList.remove('active');
  }
}

// ── Mid-session subject switch (dropdown change while live) ───────────────────

function onDropdownChange(e) {
  if (!isLive) return;
  const picked = e.target.value;
  if (!picked || picked === 'Auto' || picked === sessionSubject) return;

  const newName = PERSONA_NAMES[picked] || 'Sam';
  sessionSubject           = picked;
  state.currentSubject     = picked;
  state.subjectManuallySet = true;
  import('./subject.js').then(m => m.updateSubjectBadge(picked));

  if (ws?.readyState === WebSocket.OPEN) {
    interruptPlayback();
    skipTurn = true; // discard rest of current turn's transcript + audio
    if (currentAIBubble)   { currentAIBubble.remove();   currentAIBubble   = null; aiAccum   = ''; }
    if (currentUserBubble) { currentUserBubble.remove(); currentUserBubble = null; userAccum = ''; }
    ws.send(JSON.stringify({
      type: 'text',
      text: `The student just switched the subject to ${picked}. You are now ${newName}, the ${picked} tutor. Briefly introduce yourself as ${newName} and ask what they need help with in ${picked} today. Keep it short.`,
    }));
  }
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

async function startLive() {
  if (state.chatBusy || state.busy) { showToast('Wait for current response to finish.'); return; }

  // Read subject from dropdown at session-start
  const dropdown = document.getElementById('subjectOverride');
  const picked   = dropdown?.value;
  sessionSubject = (picked && picked !== 'Auto') ? picked : 'Other';

  // Keep state in sync
  if (sessionSubject !== 'Other') {
    state.currentSubject     = sessionSubject;
    state.subjectManuallySet = true;
    import('./subject.js').then(m => m.updateSubjectBadge(sessionSubject));
  }

  // Watch dropdown for mid-session subject changes
  dropdown?.addEventListener('change', onDropdownChange);

  setLiveSessionState('connecting');
  setMicState('processing');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: IN_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micCtx   = new AudioContext({ sampleRate: IN_RATE });
    playCtx  = new AudioContext({ sampleRate: OUT_RATE });
    gainNode = playCtx.createGain();
    gainNode.gain.value = ttsEnabled ? volume : 0;
    gainNode.connect(playCtx.destination);
    nextPlayTime = playCtx.currentTime;

    ws           = new WebSocket(WS_URL);
    ws.onopen    = () => {
      ws.send(JSON.stringify({
        type: 'setup',
        subject: sessionSubject,
        isFirstSession: true,
        history: state.conversationHistory.slice(-6),
      }));
    };
    ws.onmessage = (e) => handleMsg(JSON.parse(e.data));
    ws.onerror   = () => { showToast('Live voice error — is backend running?'); stopLive(); };
    ws.onclose   = () => { if (isLive) stopLive(); };
  } catch (e) {
    showToast('Mic error: ' + e.message);
    setLiveSessionState('idle');
    setMicState('idle');
  }
}

function handleMsg(msg) {
  switch (msg.type) {

    case 'ready':
      isLive = true;
      setMicState('live');
      setLiveSessionState('live');
      startMic();
      if (!videoEnabled) startVideo();
      if (videoEnabled) startFrameLoop();
      appendSysLive('🎙 Live Tutor — speak freely. Click "End Session" to stop.');

      setTimeout(() => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        if (sessionSubject === 'Other') {
          // No subject selected — tell user to pick from dropdown (no need to end session)
          ws.send(JSON.stringify({
            type: 'text',
            text: 'Greet the student warmly. Then tell them: "To get your specialist tutor, just pick your subject from the dropdown menu at the top of the page right now — you can change it any time during our session! We have Math, Physics, Chemistry, Biology, Computer Science, History, Literature, and Economics."',
          }));
        } else {
          // Subject already selected — introduce the right persona immediately
          ws.send(JSON.stringify({
            type: 'text',
            text: `Introduce yourself as ${voiceTutorName()} and greet the student. Let them know you're their ${sessionSubject} tutor and ask what they'd like to work on today.`,
          }));
        }
      }, 500);
      break;

    case 'audio':
      if (!skipTurn) scheduleAudio(msg.data);
      break;

    case 'transcript_out':
      if (!skipTurn && msg.text) { aiAccum = joinChunk(aiAccum, msg.text); updateVoiceAIBubble(aiAccum); }
      break;

    case 'transcript_in':
      if (!skipTurn && msg.text) { userAccum = joinChunk(userAccum, msg.text); updateVoiceUserBubble(userAccum); }
      break;

    case 'turn_complete':
      if (skipTurn) {
        skipTurn = false;
        aiAccum = ''; userAccum = '';
        if (currentAIBubble)   { currentAIBubble.remove();   currentAIBubble   = null; }
        if (currentUserBubble) { currentUserBubble.remove(); currentUserBubble = null; }
        break;
      } {
      const spokenText = aiAccum.trim();
      const userText   = userAccum.trim();

      finaliseVoiceUserBubble();

      if (spokenText && userText) {
        // User asked something — keep the live bubble visible while reformat streams in,
        // then replace it. Don't remove it upfront — that causes the flash of empty screen.
        aiAccum = '';
        const historySnapshot = state.conversationHistory.slice(-8);
        state.conversationHistory.push({ role: 'user',  content: userText });
        state.conversationHistory.push({ role: 'model', content: spokenText });
        reformatVoiceResponse(userText, historySnapshot, currentAIBubble);
        currentAIBubble = null; // ownership transferred to reformatVoiceResponse
      } else {
        finaliseVoiceAIBubble();
      }

      if (userText && DOC_TRIGGERS.test(userText)) streamDoc(userText);
      break;
    }

    case 'interrupted':
      interruptPlayback();
      finaliseVoiceAIBubble();
      break;

    case 'error':
      showToast('Live: ' + msg.error);
      stopLive();
      break;
  }
}

function stopLive() {
  isLive         = false;
  sessionSubject = 'Other';
  skipTurn       = false;
  audioMuted     = false;

  stopFrameLoop();
  processor?.disconnect();    processor    = null;
  analyserNode?.disconnect(); analyserNode = null;
  micStream?.getTracks().forEach(t => t.stop()); micStream = null;
  micCtx?.close().catch(() => {}); micCtx = null;
  setTimeout(() => { playCtx?.close().catch(() => {}); playCtx = null; gainNode = null; }, 1500);
  nextPlayTime = 0;

  if (ws?.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'end_turn' })); } catch (_) {}
    ws.close();
  }
  ws = null;

  finaliseVoiceAIBubble();
  finaliseVoiceUserBubble();
  setMicState('idle');
  setLiveSessionState('idle');
  document.querySelectorAll('.live-status').forEach(e => e.remove());

  // Remove dropdown listener so it doesn't fire after session ends
  document.getElementById('subjectOverride')?.removeEventListener('change', onDropdownChange);
}

// ── Mic ───────────────────────────────────────────────────────────────────────

function startMic() {
  const src    = micCtx.createMediaStreamSource(micStream);
  analyserNode = micCtx.createAnalyser();
  analyserNode.fftSize = 256;
  src.connect(analyserNode);

  processor    = micCtx.createScriptProcessor(CHUNK_SZ, 1, 1);
  const vadBuf = new Float32Array(analyserNode.frequencyBinCount);

  processor.onaudioprocess = (e) => {
    if (!isLive || ws?.readyState !== WebSocket.OPEN) return;

    analyserNode.getFloatTimeDomainData(vadBuf);
    let rms = 0;
    for (let i = 0; i < vadBuf.length; i++) rms += vadBuf[i] * vadBuf[i];
    rms = Math.sqrt(rms / vadBuf.length);
    const aiPlaying = playCtx && nextPlayTime > playCtx.currentTime + 0.1;
    if (rms > VAD_THRESH) {
      vadFrames++;
      if (vadFrames >= VAD_FRAMES_REQ && aiPlaying) { interruptPlayback(); vadFrames = 0; }
    } else {
      vadFrames = 0;
    }

    const pcm = f32ToI16(e.inputBuffer.getChannelData(0));
    ws.send(JSON.stringify({ type: 'audio', data: toB64(pcm.buffer), mime: `audio/pcm;rate=${IN_RATE}` }));
  };

  src.connect(processor);
  processor.connect(micCtx.destination);
}

function setMicState(s) {
  const btn = document.getElementById('btnMic');
  if (!btn) return;
  btn.classList.remove('live', 'processing');
  if (s === 'live')       { btn.classList.add('live');       btn.title = 'End live session'; }
  if (s === 'processing') { btn.classList.add('processing'); btn.title = 'Connecting…'; }
  if (s === 'idle')       { btn.title = 'Start live voice'; }
}

// ── Voice bubbles ─────────────────────────────────────────────────────────────

function updateVoiceAIBubble(text) {
  clearEmpty();
  if (!currentAIBubble) {
    currentAIBubble = appendStreamingAI(voiceTutorName(), '🎙');
  }
  // Render markdown as it arrives so the bubble looks good while the AI speaks
  updateStreamingBubbleMarkdown(currentAIBubble, text);
}

function finaliseVoiceAIBubble() {
  if (!currentAIBubble || !aiAccum.trim()) { currentAIBubble = null; aiAccum = ''; return; }
  const txt = aiAccum.trim();
  aiAccum = '';
  finaliseStreamingBubble(currentAIBubble, txt, { skipExport: true, plainText: true });
  // Only add to history if there's already a user turn — prevents model-first history
  const hist = state.conversationHistory;
  if (hist.length > 0 && hist[hist.length - 1].role === 'user') {
    hist.push({ role: 'model', content: txt });
  }
  currentAIBubble = null;
}

// ── Reformat plain voice transcript into structured markdown ─────────────────
// Called after turn_complete — streams a formatted version from /chat endpoint.

async function reformatVoiceResponse(userQuestion, historySnapshot, existingBubble = null) {
  const subject = sessionSubject;
  const name    = voiceTutorName();

  // Reuse the existing live bubble so there's no flash of empty screen.
  // If none was passed (e.g. fallback call), create a fresh one.
  const el = existingBubble || appendStreamingAI(name, '🎙');
  // Mark it as still streaming so the cursor stays visible
  el.classList.add('streaming');
  let fullReply = '';

  try {
    // Strip any leading model turns — Gemini requires history to start with 'user'
    const safeHistory = historySnapshot.filter((_, i, arr) => {
      if (i === 0 && arr[i].role === 'model') return false;
      return true;
    }).reduce((acc, turn) => {
      // Also remove consecutive same-role turns (keep last of each pair)
      if (acc.length > 0 && acc[acc.length - 1].role === turn.role) {
        acc[acc.length - 1] = turn;
      } else {
        acc.push(turn);
      }
      return acc;
    }, []);
    // Ensure it starts with user
    while (safeHistory.length > 0 && safeHistory[0].role === 'model') safeHistory.shift();

    const res = await fetch(CHAT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userQuestion,
        history: safeHistory,
        subject,
        voiceMode: true,
      }),
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
          // subject re-detection — ignore, we already know the subject
        } else if (ev.text !== undefined) {
          fullReply += ev.text;
          updateStreamingBubbleMarkdown(el, fullReply);
        } else if (ev.reply !== undefined || ev.observation !== undefined) {
          // done signal from server
        } else if (ev.error) {
          throw new Error(ev.error);
        }
      }

      if (done) break;
    }
  } catch (e) {
    console.error('[voice] reformat error:', e);
  }

  if (!fullReply.trim()) {
    // Reformat failed — fall back to showing the plain spoken transcript
    // rather than wiping the bubble entirely
    const fallback = state.conversationHistory.slice(-1)[0]?.content || '';
    if (fallback) {
      finaliseStreamingBubble(el, fallback, { skipExport: true, plainText: true });
    } else {
      el.remove();
    }
    return;
  }

  finaliseStreamingBubble(el, fullReply, { skipExport: true });
  // Update history with the formatted version
  const last = state.conversationHistory[state.conversationHistory.length - 1];
  if (last?.role === 'model') last.content = fullReply;
}

function updateVoiceUserBubble(text) {
  clearEmpty();
  if (!currentUserBubble) {
    const el = document.createElement('div');
    el.className = 'msg user user-voice-turn';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="msg-label">You 🎙 <span class="msg-time">${time}</span></div><div class="msg-bubble"></div>`;
    document.getElementById('messages').appendChild(el);
    currentUserBubble = el;
  }
  const b = currentUserBubble.querySelector('.msg-bubble');
  if (b) b.textContent = text.trim();
  scrollMsgs();
}

function finaliseVoiceUserBubble() {
  if (currentUserBubble) {
    currentUserBubble.classList.remove('user-voice-turn');
    if (userAccum.trim()) state.conversationHistory.push({ role: 'user', content: userAccum.trim() });
  }
  currentUserBubble = null;
  userAccum = '';
}

// ── Live document generation ──────────────────────────────────────────────────

async function streamDoc(userRequest) {
  const el = appendStreamingAI('📄 Live Document');
  el.classList.add('doc-card');
  const bubble = el.querySelector('.msg-bubble');
  if (bubble) bubble.classList.add('doc-body');

  let fullDoc = '';
  try {
    const res = await fetch(CHAT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: liveDocPrompt(userRequest),
        history: state.conversationHistory.slice(-8),
        subject: sessionSubject,
      }),
    });
    if (!res.ok) throw new Error('Server error');

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let   buf    = '';
    while (true) {
      const { done, value } = await reader.read();
      if (!done) buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = done ? '' : lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        let ev; try { ev = JSON.parse(raw); } catch (_) { continue; }
        if (ev.text) { fullDoc += ev.text; updateStreamingBubble(el, fullDoc); }
      }
      if (done) break;
    }
  } catch (e) {
    fullDoc = '⚠️ Could not generate document: ' + e.message;
  }

  finaliseStreamingBubble(el, fullDoc, { skipExport: true, docCard: true });
  state.conversationHistory.push({ role: 'model', content: fullDoc });
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function interruptPlayback() {
  if (!playCtx) return;
  // Stop all buffered sources immediately
  audioMuted = true;
  for (const src of activeSources) {
    try { src.stop(); } catch (_) {}
  }
  activeSources.clear();
  nextPlayTime = playCtx.currentTime;
  if (gainNode) {
    gainNode.gain.cancelScheduledValues(playCtx.currentTime);
    gainNode.gain.setValueAtTime(0, playCtx.currentTime);
  }
  // Re-enable audio after a short gap so new speech can play
  setTimeout(() => {
    audioMuted = false;
    if (gainNode && ttsEnabled) gainNode.gain.setValueAtTime(volume, playCtx?.currentTime ?? 0);
  }, 300);
}

function scheduleAudio(b64) {
  if (!playCtx || !gainNode || audioMuted) return;
  try {
    const f32 = i16ToF32(new Int16Array(fromB64(b64)));
    const buf = playCtx.createBuffer(1, f32.length, OUT_RATE);
    buf.copyToChannel(f32, 0);
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(gainNode);
    const at = Math.max(nextPlayTime, playCtx.currentTime + 0.02);
    src.start(at);
    nextPlayTime = at + buf.duration;
    activeSources.add(src);
    src.onended = () => activeSources.delete(src);
  } catch (e) { console.error('audio sched:', e); }
}

// ── PCM / base64 codec ────────────────────────────────────────────────────────

function f32ToI16(f32) {
  const o = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    o[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return o;
}
function i16ToF32(i16) {
  const o = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) o[i] = i16[i] / (i16[i] < 0 ? 0x8000 : 0x7FFF);
  return o;
}
function toB64(buf) {
  const b = new Uint8Array(buf); let s = ''; const N = 8192;
  for (let i = 0; i < b.length; i += N) s += String.fromCharCode(...b.subarray(i, i + N));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64); const b = new ArrayBuffer(s.length); const v = new Uint8Array(b);
  for (let i = 0; i < s.length; i++) v[i] = s.charCodeAt(i); return b;
}
