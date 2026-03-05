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
        text: `${persona}

---
A student has shown you the image above. Respond fully as your persona using this EXACT format:

## 📌 What I See
One sentence describing what is on the page.

## 🧠 Solution

For each step use this format:
---
### Step N: [Name of step]
[Explanation of what we are doing and why]

💡 **Key idea:** [One sentence insight]

[Working / equation / code]

**Result:** [What we got]

---
Repeat for every step. Never skip steps. Never combine steps.

## ✅ Final Answer
State the final answer clearly in bold.

## 🤔 Think About This
End with exactly ONE Socratic question to make the student think deeper.

Rules:
- Use LaTeX for ALL equations: inline $x$ and block $$x$$
- Use syntax-highlighted code blocks for all code
- Make each step visually distinct with the --- divider
- Bold all key terms on first use
- Never give the answer before showing the working`,
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

    // Re-detect subject from the chat message itself
    // If the message is off-topic from the current subject, switch persona
    const detectModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const detectResult = await detectModel.generateContent([
      { text: `What school subject is this question about? Message: "${message}". Binary numbers = Math. Code = ComputerScience. If it is a general knowledge or history question, say History. Choose ONE: Math, Physics, Chemistry, Biology, ComputerScience, History, Literature, Economics, Other. Reply with single word only.` }
    ]);
    const detectedSubject = detectSubjectFromText(detectResult.response.text());
    // Use detected subject unless it's Other (fallback to current subject)
    const activeSubject = detectedSubject !== 'Other' ? detectedSubject : subject;
    console.log(` -> Chat subject: ${activeSubject} (was: ${subject})`);

    const persona = PERSONAS[activeSubject] || PERSONAS.Other;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: `${persona}

---
You are tutoring a student. Format ALL responses like this:

For explanations or new concepts:
## 🧠 [Topic Name]
[Explanation]
**Key idea:** [insight]

For step-by-step solutions:
---
### Step N: [Step Name]
[What we do and why]
💡 **Key idea:** [insight]
[Working]
**Result:** [outcome]
---

For final answers: use ## ✅ Final Answer with the answer clearly stated.
Always end with one ## 🤔 Think About This question.
Use LaTeX for equations, syntax-highlighted code blocks for code.
Never give the answer before showing the full working.`,
    });

    const chat = model.startChat({
      history: history.map(h => ({ role: h.role, parts: [{ text: h.content }] })),
    });

    // Send detected subject to frontend so badge updates
    if (activeSubject !== subject) {
      sseWrite(res, 'subject', { subject: activeSubject });
    }

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
