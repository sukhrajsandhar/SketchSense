// ── server.js ─────────────────────────────────────────────────────────────────
// Combined SketchSense backend.
// All prompts live in prompts.js — never hardcode them here.

import express  from 'express';
import cors     from 'cors';
import dotenv   from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import { PERSONAS }             from './personas.js';
import {
  DETECT_SUBJECT_FROM_IMAGE,
  DETECT_COMPLEXITY_FROM_IMAGE,
  detectSubjectFromMessage,
  detectComplexityFromMessage,
  analyzePrompt,
  chatSystemPrompt,
  imageGenPrompt,
  liveVoiceSystemPrompt,
  liveDocPrompt,
  voiceReformatPrompt,
} from './prompts.js';

dotenv.config();

const KEY  = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3001;

console.log('\n=== STARTUP ===');
console.log('API Key:', KEY ? `${KEY.slice(0,8)}...${KEY.slice(-4)} (len:${KEY.length})` : 'MISSING!');
console.log('===============\n');

const genAI = new GoogleGenerativeAI(KEY);
const app   = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Subject detection helpers ─────────────────────────────────────────────────

const SUBJECT_MAP = {
  'math':            'Math',
  'mathematics':     'Math',
  'maths':           'Math',
  'binary':          'Math',
  'numbersystems':   'Math',
  'numbertheory':    'Math',
  'arithmetic':      'Math',
  'algebra':         'Math',
  'calculus':        'Math',
  'geometry':        'Math',
  'statistics':      'Math',
  'physics':         'Physics',
  'chemistry':       'Chemistry',
  'chem':            'Chemistry',
  'biology':         'Biology',
  'bio':             'Biology',
  'computerscience': 'ComputerScience',
  'computingscience':'ComputerScience',
  'cs':              'ComputerScience',
  'coding':          'ComputerScience',
  'programming':     'ComputerScience',
  'computing':       'ComputerScience',
  'technology':      'ComputerScience',
  'history':         'History',
  'literature':      'Literature',
  'english':         'Literature',
  'economics':       'Economics',
  'econ':            'Economics',
  'other':           'Other',
};

function detectSubjectFromText(raw) {
  console.log(` -> Raw Gemini detection: "${raw}"`);
  const firstWord  = raw.trim().split(/[\n\r\s,\.;:]+/)[0];
  const normalised = firstWord.toLowerCase().replace(/[\s_\-\.]/g, '');
  console.log(` -> Normalised: "${normalised}"`);
  const subject = SUBJECT_MAP[normalised] || 'Other';
  console.log(` -> Subject: "${subject}"`);
  return subject;
}

const COMPLEXITY_MAP = { 'beginner': 'beginner', 'intermediate': 'intermediate', 'advanced': 'advanced' };

function detectComplexityFromText(raw) {
  const firstWord = raw.trim().split(/[\n\r\s,\.;:]+/)[0].toLowerCase();
  return COMPLEXITY_MAP[firstWord] || 'intermediate';
}

// ── SSE helper ────────────────────────────────────────────────────────────────

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseSetup(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

// ── GET /health ───────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', key: KEY ? `${KEY.slice(0,8)}...` : 'MISSING' });
});

// ── POST /detect-subject  (lightweight — no full analysis) ───────────────────
// Body: { message?: string }  →  Returns: { subject: string }

app.post('/detect-subject', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  try {
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent([{ text: detectSubjectFromMessage(message) }]);
    const subject = detectSubjectFromText(result.response.text());
    console.log(`[detect-subject] "${message.slice(0,40)}" → ${subject}`);
    res.json({ subject });
  } catch (err) {
    console.error('detect-subject error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /analyze  (streaming SSE) ───────────────────────────────────────────
// Events: subject { subject } | chunk { text } | done { observation, subject } | error { error }

app.post('/analyze', async (req, res) => {
  const { image, subjectOverride } = req.body;
  if (!image) return res.status(400).json({ error: 'Missing image' });

  sseSetup(res);

  try {
    console.log(`[${new Date().toISOString()}] Analyzing frame (streaming)…`);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Step 1: Detect subject and complexity in parallel
    let subject = subjectOverride || null;
    let complexity = 'intermediate';

    if (!subject) {
      const [detectResult, complexityResult] = await Promise.all([
        model.generateContent([
          { inlineData: { mimeType: 'image/jpeg', data: image } },
          { text: DETECT_SUBJECT_FROM_IMAGE },
        ]),
        model.generateContent([
          { inlineData: { mimeType: 'image/jpeg', data: image } },
          { text: DETECT_COMPLEXITY_FROM_IMAGE },
        ]),
      ]);
      subject    = detectSubjectFromText(detectResult.response.text());
      complexity = detectComplexityFromText(complexityResult.response.text());
    } else {
      // Subject overridden but still detect complexity
      const complexityResult = await model.generateContent([
        { inlineData: { mimeType: 'image/jpeg', data: image } },
        { text: DETECT_COMPLEXITY_FROM_IMAGE },
      ]);
      complexity = detectComplexityFromText(complexityResult.response.text());
    }

    console.log(` -> subject=${subject}, complexity=${complexity}`);
    sseWrite(res, 'subject', { subject });

    // Step 2: Stream full analysis
    const persona = PERSONAS[subject] || PERSONAS.Other;
    const streamResult = await model.generateContentStream([
      { inlineData: { mimeType: 'image/jpeg', data: image } },
      { text: analyzePrompt(persona, complexity) },
    ]);

    let fullText = '';
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) { fullText += text; sseWrite(res, 'chunk', { text }); }
    }

    sseWrite(res, 'done', { observation: fullText, subject });
    console.log(` -> stream complete. subject=${subject}, chars=${fullText.length}`);
    res.end();

  } catch (err) {
    console.error('Gemini error:', err.message);
    sseWrite(res, 'error', { error: err.message });
    res.end();
  }
});

// ── POST /chat  (streaming SSE) ───────────────────────────────────────────────
// Events: subject { subject } | chunk { text } | done { reply } | error { error }

app.post('/chat', async (req, res) => {
  const { message, history = [], subject = 'Other', voiceMode = false } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  sseSetup(res);

  try {
    console.log(`[${new Date().toISOString()}] Chat [${subject}]: "${message}"`);

    // Re-detect subject and complexity from message + history
    const detectModel  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const [detectResult, complexityResult] = await Promise.all([
      detectModel.generateContent([{ text: detectSubjectFromMessage(message) }]),
      detectModel.generateContent([{ text: detectComplexityFromMessage(message, history) }]),
    ]);
    const detected      = detectSubjectFromText(detectResult.response.text());
    const complexity    = detectComplexityFromText(complexityResult.response.text());
    const activeSubject = detected !== 'Other' ? detected : subject;
    console.log(` -> Chat subject: ${activeSubject} (was: ${subject}), complexity: ${complexity}`);

    const persona   = PERSONAS[activeSubject] || PERSONAS.Other;
    const sysPrompt = voiceMode
      ? voiceReformatPrompt(persona, complexity)
      : chatSystemPrompt(persona, complexity);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: sysPrompt,
    });

    const chat = model.startChat({
      history: history.map(h => ({ role: h.role, parts: [{ text: h.content }] })),
    });

    if (activeSubject !== subject) {
      sseWrite(res, 'subject', { subject: activeSubject });
    }

    const streamResult = await chat.sendMessageStream(message);
    let fullReply = '';
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) { fullReply += text; sseWrite(res, 'chunk', { text }); }
    }

    sseWrite(res, 'done', { reply: fullReply });
    console.log(` -> chat done. chars=${fullReply.length}`);
    res.end();

  } catch (err) {
    console.error('Chat error:', err.message);
    sseWrite(res, 'error', { error: err.message });
    res.end();
  }
});

// ── POST /generate-image ──────────────────────────────────────────────────────

app.post('/generate-image', async (req, res) => {
  const { prompt, subject = 'Other' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    console.log(`[${new Date().toISOString()}] Image gen [${subject}]: "${prompt}"`);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: imageGenPrompt(subject, prompt) }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      }
    );

    const json = await response.json();
    if (!response.ok) return res.status(500).json({ error: json.error?.message || 'Image generation failed' });

    let imageBase64 = null, mimeType = 'image/png', caption = null;
    for (const part of json.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) { imageBase64 = part.inlineData.data; mimeType = part.inlineData.mimeType || 'image/png'; }
      else if (part.text)         { caption = part.text; }
    }

    if (!imageBase64) return res.json({ imageBase64: null, caption: caption || 'Could not generate image.' });
    console.log(` -> image OK (${Math.round(imageBase64.length * 0.75 / 1024)} KB)`);
    res.json({ imageBase64, mimeType, caption });

  } catch (err) {
    console.error('Image gen error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket /live — Gemini Live API proxy ───────────────────────────────────

const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const LIVE_URL   = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${KEY}`;

const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer, path: '/live' });

wss.on('connection', (browserWs) => {
  console.log(`[${new Date().toISOString()}] Live session opened`);

  const geminiWs = new WebSocket(LIVE_URL);
  let setupSent  = false;
  let subject    = 'Other';

  // ── Browser → Gemini ──────────────────────────────────────────────────────
  browserWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // { type: 'setup', subject, history }
      if (msg.type === 'setup') {
        subject = msg.subject || 'Other';
        const persona = PERSONAS[subject] || PERSONAS.Other;
        const isFirstSession = msg.isFirstSession !== false; // default true

        const setupPayload = {
          setup: {
            model: `models/${LIVE_MODEL}`,
            generation_config: {
              response_modalities: ['AUDIO'],
              speech_config: {
                voice_config: { prebuilt_voice_config: { voice_name: 'Aoede' } },
              },
            },
            output_audio_transcription: {},
            input_audio_transcription:  {},
            system_instruction: {
              parts: [{ text: liveVoiceSystemPrompt(persona, isFirstSession) }],
            },
          },
        };

        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify(setupPayload));
          setupSent = true;
        } else {
          geminiWs.once('open', () => {
            geminiWs.send(JSON.stringify(setupPayload));
            setupSent = true;
          });
        }
        return;
      }

      if (!setupSent) return;

      // { type: 'audio', data, mime }
      if (msg.type === 'audio') {
        geminiWs.readyState === WebSocket.OPEN && geminiWs.send(JSON.stringify({
          realtime_input: { media_chunks: [{ mime_type: msg.mime || 'audio/pcm;rate=16000', data: msg.data }] },
        }));
        return;
      }

      // { type: 'video', data } — base64 JPEG frame from student's camera
      if (msg.type === 'video') {
        geminiWs.readyState === WebSocket.OPEN && geminiWs.send(JSON.stringify({
          realtime_input: { media_chunks: [{ mime_type: 'image/jpeg', data: msg.data }] },
        }));
        return;
      }

      // { type: 'text', text } — send a text prompt to Gemini (e.g. greeting trigger)
      if (msg.type === 'text') {
        geminiWs.readyState === WebSocket.OPEN && geminiWs.send(JSON.stringify({
          client_content: {
            turns: [{ role: 'user', parts: [{ text: msg.text }] }],
            turn_complete: true,
          },
        }));
        return;
      }

      // { type: 'text', text } — inject a text prompt (e.g. greeting trigger)
      if (msg.type === 'text') {
        geminiWs.readyState === WebSocket.OPEN && geminiWs.send(JSON.stringify({
          client_content: {
            turns: [{ role: 'user', parts: [{ text: msg.text }] }],
            turn_complete: true,
          },
        }));
        return;
      }

      // { type: 'end_turn' }
      if (msg.type === 'end_turn') {
        geminiWs.readyState === WebSocket.OPEN && geminiWs.send(JSON.stringify({
          client_content: { turn_complete: true },
        }));
      }

    } catch (e) {
      console.error('Live: browser parse error', e.message);
    }
  });

  // ── Gemini → Browser ──────────────────────────────────────────────────────
  geminiWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.setupComplete) {
        browserWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      const parts = msg.serverContent?.modelTurn?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.inlineData?.data) {
            browserWs.send(JSON.stringify({ type: 'audio', data: part.inlineData.data, mime: part.inlineData.mimeType || 'audio/pcm;rate=24000' }));
          }
          if (part.text) {
            browserWs.send(JSON.stringify({ type: 'text', text: part.text }));
          }
        }
      }

      const outTranscript = msg.serverContent?.outputTranscription?.text;
      if (outTranscript) browserWs.send(JSON.stringify({ type: 'transcript_out', text: outTranscript }));

      const inTranscript = msg.serverContent?.inputTranscription?.text;
      if (inTranscript)  browserWs.send(JSON.stringify({ type: 'transcript_in',  text: inTranscript  }));

      if (msg.serverContent?.turnComplete)  browserWs.send(JSON.stringify({ type: 'turn_complete' }));
      if (msg.serverContent?.interrupted)   browserWs.send(JSON.stringify({ type: 'interrupted' }));

    } catch (e) {
      console.error('Live: Gemini parse error', e.message);
    }
  });

  geminiWs.on('error', (err) => {
    console.error('Live: Gemini WS error:', err.message);
    browserWs.send(JSON.stringify({ type: 'error', error: err.message }));
  });

  geminiWs.on('close', (code) => {
    console.log(`[${new Date().toISOString()}] Gemini WS closed: ${code}`);
    if (browserWs.readyState === WebSocket.OPEN) browserWs.close();
  });

  browserWs.on('close', () => {
    console.log(`[${new Date().toISOString()}] Browser disconnected`);
    if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });

  browserWs.on('error', (e) => console.error('Live: browser WS error:', e.message));
});

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀 Backend on http://localhost:${PORT}`);
  console.log(`  GET  /health         — status check`);
  console.log(`  POST /analyze        — streaming vision analysis`);
  console.log(`  POST /chat           — streaming chat`);
  console.log(`  POST /generate-image — image generation`);
  console.log(`  WS   /live           — Gemini Live Audio + Video\n`);
});
