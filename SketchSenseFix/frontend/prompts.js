// ── prompts.js (frontend) ─────────────────────────────────────────────────────
// Frontend-side prompt constants and trigger patterns.
// Keep in sync with backend/prompts.js for shared concepts.

// ── Image generation trigger ───────────────────────────────────────────────────
// If a chat message matches this, route to /generate-image instead of /chat
export const IMAGE_TRIGGERS = /\b(draw|diagram|illustrate|sketch|show me|visuali[sz]e|generate.*image|image of|picture of|chart of|map of|with a diagram|with diagram|labeled diagram|label.{0,20}diagram|explain.{0,30}diagram|diagram.{0,30}explain)\b/i;

// ── Voice: live document trigger ───────────────────────────────────────────────
// If user speech matches this, stream a written document in addition to voice reply
export const DOC_TRIGGERS = /\b(write me|write out|step by step|show me|generate|make me a|give me a|create a|document|explain in writing|write it out|notes on|write notes|lay it out)\b/i;

// ── Voice: live document prompt ────────────────────────────────────────────────
// Sent to /chat when doc trigger fires after a voice turn
export function liveDocPrompt(userRequest) {
  return `The student asked (via voice): "${userRequest}". Generate a clear, structured written document — use headings, numbered steps, bullet points, bold key terms, and code blocks if relevant. Make it something the student can read, follow along with, and keep as study notes. Be thorough.`;
}

// ── Persona display names ──────────────────────────────────────────────────────
export const PERSONA_NAMES = {
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
