// ── server.js ─────────────────────────────────────────────────────────────────
import express  from 'express';
import cors     from 'cors';
import dotenv   from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PERSONAS } from './personas.js';

dotenv.config();

const KEY = process.env.GEMINI_API_KEY;
console.log('\n=== STARTUP ===');
console.log('API Key:', KEY ? `${KEY.slice(0,8)}...${KEY.slice(-4)} (len:${KEY.length})` : 'MISSING!');
console.log('===============\n');

const genAI = new GoogleGenerativeAI(KEY);
const app   = express();
const PORT  = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Fuzzy subject matcher ─────────────────────────────────────────────────────
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
  const firstWord = raw.trim().split(/[\n\r\s,\.;:]+/)[0];
  const normalised = firstWord.toLowerCase().replace(/[\s_\-\.]/g, '');
  console.log(` -> Normalised: "${normalised}"`);
  const subject = SUBJECT_MAP[normalised] || 'Other';
  console.log(` -> Subject: "${subject}"`);
  return subject;
}

// ── SSE helper — sends a single event ────────────────────────────────────────
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', key: KEY ? `${KEY.slice(0,8)}...` : 'MISSING' });
});

// ── POST /analyze  (streaming via SSE) ───────────────────────────────────────
// Returns a text/event-stream with events:
//   subject  { subject }          — sent as soon as detection is done
//   chunk    { text }             — streamed tokens from Gemini
//   done     { observation }      — full text when complete
//   error    { error }
app.post('/analyze', async (req, res) => {
  const { image, subjectOverride } = req.body;
  if (!image) return res.status(400).json({ error: 'Missing image' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    console.log(`[${new Date().toISOString()}] Analyzing frame (streaming)...`);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Step 1: Detect subject (fast, non-streamed)
    let subject = subjectOverride || null;
    if (!subject) {
      const detectResult = await model.generateContent([
        { inlineData: { mimeType: 'image/jpeg', data: image } },
        { text: 'What school subject is shown in this image? Binary numbers = Math. Code = ComputerScience. Choose ONE: Math, Physics, Chemistry, Biology, ComputerScience, History, Literature, Economics, Other. Reply with the single word only, no explanation.' },
      ]);
      subject = detectSubjectFromText(detectResult.response.text());
    }

    // Send subject immediately so badge updates before streaming starts
    sseWrite(res, 'subject', { subject });

    // Step 2: Stream the full analysis
    const persona = PERSONAS[subject] || PERSONAS.Other;
    const streamResult = await model.generateContentStream([
      { inlineData: { mimeType: 'image/jpeg', data: image } },
      {
        text: `## RESPONSE FORMAT RULES — OVERRIDE YOUR PERSONA STYLE

STEP 1: Output this hidden block first, always:
<details>
<summary>📌 What I See</summary>
[One sentence: what is written or drawn]
</details>

STEP 2: Classify the content, then respond EXACTLY as shown:

━━━ SIMPLE: basic fact or trivial question (e.g. "what is 1+1", "what is the capital of France") ━━━
ONE sentence answer. ONE sentence context. STOP. No follow-up question.
EXAMPLE for "what is 1+1": 1 + 1 = 2. Adding one unit to another gives a total of two.
NO headers. NO paragraphs. NO 🤔 question. 2 sentences MAX.

━━━ MEDIUM: concept, diagram, or explain/why/how question ━━━
## 🧠 [Topic]
2–3 paragraphs with **bold key terms**.

━━━ COMPLEX: equation to solve, proof, multi-step working ━━━
## 🧠 Solution
---
### Step [N]: [Name]
[Explanation paragraph]
💡 **Key idea:** [insight]
$$[working]$$
**Result:** [outcome]
---
## ✅ Final Answer

RULES:
- For SIMPLE: 2 sentences max. No headers. No enthusiasm. No follow-up question. STOP after context sentence.
- LaTeX for math, code blocks for code.

---
YOUR PERSONA (use this voice, obey format rules above):
${persona}`,
      },
    ]);

    // Stream chunks to client
    let fullText = '';
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        sseWrite(res, 'chunk', { text });
      }
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

// ── POST /chat  (streaming via SSE) ──────────────────────────────────────────
// Returns a text/event-stream with events:
//   chunk  { text }
//   done   { reply }
//   error  { error }
app.post('/chat', async (req, res) => {
  const { message, history = [], subject = 'Other' } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    console.log(`[${new Date().toISOString()}] Chat stream [${subject}]: "${message}"`);

    // Always detect subject fresh from the latest message
    let activeSubject = subject;
    const detectModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const detectResult = await detectModel.generateContent([
      { text: `What school subject is this question about? Judge only this message: "${message}". Choose ONE: Math, Physics, Chemistry, Biology, ComputerScience, History, Literature, Economics, Other. Reply single word only.` }
    ]);
    const detected = detectSubjectFromText(detectResult.response.text());
    if (detected && detected !== 'Other') activeSubject = detected;
    console.log(` -> Chat subject: ${activeSubject} (was: ${subject})`);

    const persona = PERSONAS[activeSubject] || PERSONAS.Other;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: `## RESPONSE FORMAT RULES — OVERRIDE YOUR PERSONA STYLE

Classify the question, then respond EXACTLY as shown:

━━━ SIMPLE: basic fact or trivial question (e.g. "what is 1+1", "what is gravity", "what year was X") ━━━
ONE sentence answer. ONE sentence context. STOP. No follow-up question.
EXAMPLE for "what is 1+1": 1 + 1 = 2. Combining one unit with another gives a total of two.
NO headers. NO paragraphs. NO enthusiasm. NO 🤔 question. 2 sentences MAX.

━━━ MEDIUM: explain how/why, concept questions, diagrams ━━━
## 🧠 [Topic]
2–3 paragraphs with **bold key terms**.

━━━ COMPLEX: solve, calculate, prove, derive, multi-step ━━━
## 🧠 Solution
---
### Step [N]: [Name]
[Explanation paragraph]
💡 **Key idea:** [insight]
$$[working]$$
**Result:** [outcome]
---
## ✅ Final Answer

LaTeX for math ($x$ inline, $$x$$ block). Code blocks for code.

---
YOUR PERSONA (use this voice, obey format rules above):
${persona}`,
    });

    const chat = model.startChat({
      history: history.map(h => ({ role: h.role, parts: [{ text: h.content }] })),
    });

    // Always send subject first so frontend uses correct persona name before streaming
    sseWrite(res, 'subject', { subject: activeSubject });

    const streamResult = await chat.sendMessageStream(message);

    let fullReply = '';
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) {
        fullReply += text;
        sseWrite(res, 'chunk', { text });
      }
    }

    sseWrite(res, 'done', { reply: fullReply });
    console.log(` -> chat stream complete. chars=${fullReply.length}`);
    res.end();

  } catch (err) {
    console.error('Chat error:', err.message);
    sseWrite(res, 'error', { error: err.message });
    res.end();
  }
});

// ── POST /generate-image  (not streamed — image gen doesn't support it) ───────
app.post('/generate-image', async (req, res) => {
  const { prompt, subject = 'Other' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    console.log(`[${new Date().toISOString()}] Generating image [${subject}]: "${prompt}"`);

    const subjectHint = {
      Math:            'mathematical diagram with clean notation and labeled axes',
      Physics:         'physics diagram with labeled forces, vectors, and units',
      Chemistry:       'molecular structure or chemical reaction diagram, clearly labeled',
      Biology:         'biological diagram with labeled parts, anatomical or cellular',
      ComputerScience: 'flowchart or data structure diagram with clear nodes and edges',
      History:         'historical timeline or map, clearly labeled with dates',
      Literature:      'conceptual mind map or thematic diagram',
      Economics:       'economic graph with labeled axes, curves, and equilibrium points',
      Other:           'clear, well-labeled educational diagram',
    }[subject] || 'clear, well-labeled educational diagram';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `Create a ${subjectHint}: ${prompt}` }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      }
    );

    const json = await response.json();
    if (!response.ok) return res.status(500).json({ error: json.error?.message || 'Image generation failed' });

    let imageBase64 = null, mimeType = 'image/png', caption = null;
    for (const part of json.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) { imageBase64 = part.inlineData.data; mimeType = part.inlineData.mimeType || 'image/png'; }
      else if (part.text) { caption = part.text; }
    }

    if (!imageBase64) return res.json({ imageBase64: null, caption: caption || 'Could not generate image.' });
    console.log(` -> image OK (${Math.round(imageBase64.length * 0.75 / 1024)} KB)`);
    res.json({ imageBase64, mimeType, caption });

  } catch (err) {
    console.error('Image gen error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Backend on http://localhost:${PORT}`);
  console.log(`  GET  /health         - status check`);
  console.log(`  POST /analyze        - streaming vision analysis`);
  console.log(`  POST /chat           - streaming chat`);
  console.log(`  POST /generate-image - image generation\n`);
});
