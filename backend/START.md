# ⬡ Whiteboard Co-Pilot — Setup

## ⚠️ First: Rotate your API key
Your old key was exposed in chat. Get a new one at:
👉 https://aistudio.google.com/app/apikey

## 1. Add your new API key
Open `backend/.env` and replace the placeholder:
```
GEMINI_API_KEY=your_new_key_here
```

## 2. Install & start the backend
```bash
cd backend
npm install
npm run dev
```
Backend runs at → http://localhost:3001

## 3. Open the frontend
Just open `frontend/index.html` in your browser (double-click it).

## 4. Test it works
```bash
curl http://localhost:3001/health
# Should return: {"status":"ok","model":"gemini-2.0-flash",...}
```

## Done!
- Point camera at a whiteboard/notebook
- Click **Analyze Frame** or press **Space**
