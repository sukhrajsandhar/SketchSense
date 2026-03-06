// ── voice.js ──────────────────────────────────────────────────────────────────
// Gemini Live API — real-time voice + video tutoring.
// Uses shared message functions from messages.js for all bubble rendering.

import { state }           from './state.js';
import { showToast }       from './ui.js';
import { DOC_TRIGGERS, liveDocPrompt } from './prompts.js';
import {
  tutorName, clearEmpty, scrollMsgs,
  appendStreamingAI, updateStreamingBubble, finaliseStreamingBubble,
  appendSysLive,
} from './messages.js';

const WS_URL    = 'ws://localhost:3001/live';
const CHAT_URL  = 'http://localhost:3001/chat';
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
let vidStream   = null;
let vidInterval = null;
let vidCanvas   = null;
let vidCtx2d    = null;
let videoEnabled = false;

// Active streaming bubbles
let currentAIBubble   = null;   // appendStreamingAI() element
let currentUserBubble = null;
let aiAccum           = '';
let userAccum         = '';

// VAD
let vadFrames        = 0;
const VAD_THRESH     = 0.015;
const VAD_FRAMES_REQ = 4;

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

export function stopSpeaking() { interruptPlayback(); }

// ── Live camera toggle ────────────────────────────────────────────────────────

export async function toggleLiveCamera() {
  if (videoEnabled) stopVideo(); else await startVideo();
}

async function startVideo() {
  try {
    vidStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    });
    const pip = document.getElementById('pipVideo');
    if (pip) pip.srcObject = vidStream;
    document.getElementById('pipWrap')?.classList.add('active');

    vidCanvas        = document.createElement('canvas');
    vidCanvas.width  = 640;
    vidCanvas.height = 480;
    vidCtx2d         = vidCanvas.getContext('2d');
    videoEnabled     = true;
    setCamBtnState('on');

    if (isLive && ws?.readyState === WebSocket.OPEN) startFrameLoop();
  } catch (e) {
    showToast('Camera error: ' + e.message);
  }
}

function stopVideo() {
  stopFrameLoop();
  vidStream?.getTracks().forEach(t => t.stop());
  vidStream = null;
  const pip = document.getElementById('pipVideo');
  if (pip) pip.srcObject = null;
  document.getElementById('pipWrap')?.classList.remove('active');
  videoEnabled = false;
  vidCanvas = null; vidCtx2d = null;
  setCamBtnState('off');
}

function startFrameLoop() {
  if (vidInterval) return;
  const pip = document.getElementById('pipVideo');
  vidInterval = setInterval(() => {
    if (!vidCtx2d || !vidCanvas || ws?.readyState !== WebSocket.OPEN) return;
    const src = pip && pip.videoWidth > 0 ? pip : null;
    if (!src) return;
    vidCanvas.width  = src.videoWidth  || 640;
    vidCanvas.height = src.videoHeight || 480;
    vidCtx2d.drawImage(src, 0, 0);
    const b64 = vidCanvas.toDataURL('image/jpeg', JPEG_Q).split(',')[1];
    if (b64) ws.send(JSON.stringify({ type: 'video', data: b64 }));
  }, 1000 / VIDEO_FPS);
}

function stopFrameLoop() {
  if (vidInterval) { clearInterval(vidInterval); vidInterval = null; }
}

function setCamBtnState(s) {
  const btn = document.getElementById('btnCam');
  if (!btn) return;
  btn.classList.toggle('cam-on', s === 'on');
  btn.title = s === 'on' ? 'Stop sharing camera' : 'Share camera with AI';
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

async function startLive() {
  if (state.chatBusy || state.busy) { showToast('Wait for current response to finish.'); return; }
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
    ws.onopen    = () => ws.send(JSON.stringify({ type: 'setup', subject: state.currentSubject || 'Other', history: state.conversationHistory.slice(-6) }));
    ws.onmessage = (e) => handleMsg(JSON.parse(e.data));
    ws.onerror   = () => { showToast('Live voice error — is backend running?'); stopLive(); };
    ws.onclose   = () => { if (isLive) stopLive(); };
    setMicState('processing');
  } catch (e) {
    showToast('Mic error: ' + e.message);
  }
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'ready':
      isLive = true;
      setMicState('live');
      startMic();
      if (videoEnabled) startFrameLoop();
      appendSysLive('🎙 Live — speak freely. Click mic to end.');
      break;

    case 'audio':
      scheduleAudio(msg.data);
      break;

    case 'transcript_out':
      if (msg.text) { aiAccum += msg.text + ' '; updateVoiceAIBubble(aiAccum); }
      break;

    case 'transcript_in':
      if (msg.text) { userAccum += msg.text + ' '; updateVoiceUserBubble(userAccum); }
      break;

    case 'turn_complete':
      finaliseVoiceAIBubble();
      if (userAccum.trim() && DOC_TRIGGERS.test(userAccum)) {
        streamDoc(userAccum.trim());
      }
      finaliseVoiceUserBubble();
      break;

    case 'interrupted':
      interruptPlayback();
      finaliseVoiceAIBubble();
      break;

    case 'error':
      showToast('Live: ' + msg.error); stopLive(); break;
  }
}

function startMic() {
  const src    = micCtx.createMediaStreamSource(micStream);
  analyserNode = micCtx.createAnalyser();
  analyserNode.fftSize = 256;
  src.connect(analyserNode);

  processor    = micCtx.createScriptProcessor(CHUNK_SZ, 1, 1);
  const vadBuf = new Float32Array(analyserNode.frequencyBinCount);

  processor.onaudioprocess = (e) => {
    if (!isLive || ws?.readyState !== WebSocket.OPEN) return;

    // VAD — interrupt AI if user speaks while AI audio is playing
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

    // Send PCM
    const pcm = f32ToI16(e.inputBuffer.getChannelData(0));
    ws.send(JSON.stringify({ type: 'audio', data: toB64(pcm.buffer), mime: `audio/pcm;rate=${IN_RATE}` }));
  };

  src.connect(processor);
  processor.connect(micCtx.destination);
}

function stopLive() {
  isLive = false;
  stopFrameLoop();
  processor?.disconnect();    processor = null;
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
  document.querySelectorAll('.live-status').forEach(e => e.remove());
}

// ── Audio interruption ────────────────────────────────────────────────────────

function interruptPlayback() {
  if (!gainNode || !playCtx) return;
  gainNode.gain.cancelScheduledValues(playCtx.currentTime);
  gainNode.gain.setValueAtTime(0, playCtx.currentTime);
  nextPlayTime = playCtx.currentTime;
  setTimeout(() => {
    if (gainNode && ttsEnabled) gainNode.gain.setValueAtTime(volume, playCtx?.currentTime ?? 0);
  }, 150);
}

// ── Gapless audio playback ────────────────────────────────────────────────────

function scheduleAudio(b64) {
  if (!playCtx || !gainNode) return;
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
  } catch (e) { console.error('audio sched:', e); }
}

// ── Voice bubble helpers (use shared message functions) ───────────────────────

function updateVoiceAIBubble(text) {
  clearEmpty();
  if (!currentAIBubble) {
    // Use the correct persona name (tutor name) with voice icon
    currentAIBubble = appendStreamingAI(tutorName(), '🎙');
  }
  updateStreamingBubble(currentAIBubble, text);
}

function finaliseVoiceAIBubble() {
  if (!currentAIBubble || !aiAccum.trim()) { currentAIBubble = null; aiAccum = ''; return; }
  const txt = aiAccum.trim();
  aiAccum = '';
  // Full markdown render + copy button — skipExport for voice bubbles
  finaliseStreamingBubble(currentAIBubble, txt, { skipExport: true, plainText: true });
  state.conversationHistory.push({ role: 'model', content: txt });
  currentAIBubble = null;
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
    if (userAccum.trim()) {
      state.conversationHistory.push({ role: 'user', content: userAccum.trim() });
    }
  }
  currentUserBubble = null;
  userAccum = '';
}

// ── Live document generation ──────────────────────────────────────────────────
// Triggered when voice transcript matches DOC_TRIGGERS.
// Uses shared appendStreamingAI / updateStreamingBubble / finaliseStreamingBubble.

async function streamDoc(userRequest) {
  const subject = state.currentSubject || 'Other';

  // Create a doc-card bubble using the shared helper
  const el = appendStreamingAI('📄 Live Document');
  // Add doc-card class for the green border styling
  el.classList.add('doc-card');
  // Replace msg-bubble with doc-body for doc card CSS
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
        subject,
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
        if (ev.text) {
          fullDoc += ev.text;
          updateStreamingBubble(el, fullDoc);
        }
      }
      if (done) break;
    }
  } catch (e) {
    fullDoc = '⚠️ Could not generate document: ' + e.message;
  }

  // Finalise with full markdown render + copy button. Skip export dropdown.
  finaliseStreamingBubble(el, fullDoc, { skipExport: true, docCard: true });
  state.conversationHistory.push({ role: 'model', content: fullDoc });
}

// ── Mic button state ──────────────────────────────────────────────────────────

function setMicState(s) {
  const btn = document.getElementById('btnMic');
  if (!btn) return;
  btn.classList.remove('live', 'processing');
  if (s === 'live')       { btn.classList.add('live');       btn.title = 'End live session'; }
  if (s === 'processing') { btn.classList.add('processing'); btn.title = 'Connecting…'; }
  if (s === 'idle')       { btn.title = 'Start live voice'; }
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
