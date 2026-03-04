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

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', key: KEY ? `${KEY.slice(0,8)}...` : 'MISSING' });
});

// ── POST /analyze ─────────────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  const { image, subjectOverride } = req.body;
  if (!image) return res.status(400).json({ error: 'Missing image' });

  try {
    console.log(`[${new Date().toISOString()}] Analyzing frame...`);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Step 1: Detect subject
    let subject = subjectOverride || null;

    if (!subject) {
      const detectResult = await model.generateContent([
        { inlineData: { mimeType: 'image/jpeg', data: image } },
        { text: 'What school subject is shown in this image? Binary numbers = Math. Code = ComputerScience. Choose ONE: Math, Physics, Chemistry, Biology, ComputerScience, History, Literature, Economics, Other. Reply with the single word only, no explanation.' },
      ]);
      subject = detectSubjectFromText(detectResult.response.text());
    }

    // Step 2: Full analysis with persona
    const persona = PERSONAS[subject] || PERSONAS.Other;

    const analyzeResult = await model.generateContent([
      { inlineData: { mimeType: 'image/jpeg', data: image } },
      {
        text: `${persona}

---
A student has shown you the image above.
Identify what is written or drawn, then respond fully as your persona.
- Solve math/science problems step by step
- Answer questions completely
- Explain diagrams deeply
- Use markdown: **bold**, bullets, code blocks, LaTeX for equations
- End with ONE guiding question`,
      },
    ]);

    const observation = analyzeResult.response.text();
    console.log(` -> done. subject=${subject}`);
    res.json({ observation, subject });

  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /chat ────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, history = [], subject = 'Other' } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  try {
    console.log(`[${new Date().toISOString()}] Chat [${subject}]: "${message}"`);
    const persona = PERSONAS[subject] || PERSONAS.Other;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: `${persona}\n\n---\nStay in character. Use markdown. Give teaching-focused answers.`,
    });

    const chat = model.startChat({
      history: history.map(h => ({ role: h.role, parts: [{ text: h.content }] })),
    });

    const result = await chat.sendMessage(message);
    const reply  = result.response.text();
    console.log(` -> ${reply.slice(0, 80)}...`);
    res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate-image ──────────────────────────────────────────────────────
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
  console.log(`Backend running on http://localhost:${PORT}\n`);
});
