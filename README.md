# SketchSense — Quick Start

## First time setup
```
cd backend
npm install
```

## Set your API key
Create `backend/.env`:
```
GEMINI_API_KEY=your_key_here
```

## Start
```
cd backend
node server.js
```
Then open `frontend/index.html` in your browser.

## Features
- 📷 **Analyze** — point camera at notebook/whiteboard, hit Analyze
- 💬 **Chat** — text chat with subject-aware AI tutor
- 🎙 **Voice** — click mic for real-time voice conversation (Gemini Live)
- 📹 **Video** — click the video button to share your camera with the AI tutor
- 🖼 **Image gen** — say "draw a diagram of..." to generate visuals
- 📄 **Live docs** — say "write me step by step..." to get a written document
- 🔊 **Volume** — slider to control AI voice volume
- 🔇 **Mute** — mute/unmute AI voice without ending session

## File structure
```
backend/
  server.js      — Express + WebSocket server
  personas.js    — AI tutor personalities per subject
  prompts.js     — All Gemini prompt templates (edit here!)

frontend/
  app.js         — Entry point, wires up all modules
  prompts.js     — Frontend prompt constants and trigger regexes
  voice.js       — Gemini Live API (voice + video)
  camera.js      — Webcam capture and frame analysis
  messages.js    — Chat UI and streaming bubble logic
  subject.js     — Subject detection badge and override dropdown
  export.js      — PDF, PNG, Markdown export
  ui.js          — Theme, sidebar, toast, status pip
  state.js       — Shared app state
  styles.css     — All styles
  index.html     — App shell
```

## Editing prompts
All AI prompts are in `backend/prompts.js` — change tone, format, structure there.
Frontend trigger patterns (image gen, live doc, voice doc) are in `frontend/prompts.js`.
