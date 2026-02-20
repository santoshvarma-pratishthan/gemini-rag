# Gemini RAG — React Frontend Prompt

## Project Overview

Build a **React frontend** for a Gemini-powered RAG (Retrieval Augmented Generation) server. The backend is a Node.js/Express API that manages a Q&A knowledge base with semantic search powered by PostgreSQL (pgvector) and Google Gemini AI.

**Design Requirements:**
- **Full dark theme** — deep blacks (#0a0a0f), dark grays (#111118, #1a1a25), with vibrant accent colors (electric blue #3b82f6, purple #8b5cf6, emerald #10b981)
- Premium, modern UI with glassmorphism cards, subtle glow effects, smooth animations
- Responsive layout (mobile-first)
- Use **React + Vite**, styled with vanilla CSS or Tailwind (dark mode)
- Google Font: **Inter** or **Outfit**

---

## Backend API Base URL

```
Production: https://gemini-rag-server-latest.onrender.com
Local:      http://localhost:3000
```

Swagger docs available at: `{BASE_URL}/api-docs`

---

## API Endpoints

### 1. Register a Question

```
POST /questions
Content-Type: application/json

Body: { "content": "How do I fix CORS errors in Express?" }

Response:
{
  "success": true,
  "question": {
    "id": 1,
    "content": "How do I fix CORS errors in Express?",
    "created_at": "2026-02-21T00:00:00.000Z"
  }
}
```

**What it does:** Takes a question string, generates a Gemini AI embedding (3072-dim vector), and saves both to the database for future semantic search.

---

### 2. List All Questions

```
GET /questions

Response:
{
  "success": true,
  "questions": [
    { "id": 1, "content": "How do I fix CORS errors?", "created_at": "..." },
    { "id": 2, "content": "What is pgvector?", "created_at": "..." }
  ]
}
```

---

### 3. Add an Answer

```
POST /answers
Content-Type: application/json

Body: { "question_id": 1, "content": "Use the cors middleware package..." }

Response:
{
  "success": true,
  "message": "Answer added for question 1",
  "answer": {
    "id": 1,
    "question_id": 1,
    "content": "Use the cors middleware package...",
    "created_at": "..."
  }
}
```

**Note:** Returns 404 if the question_id doesn't exist.

---

### 4. Get Answers for a Question

```
GET /answers/:question_id

Example: GET /answers/1

Response:
{
  "success": true,
  "answers": [
    { "id": 1, "question_id": 1, "content": "Use cors middleware...", "created_at": "..." },
    { "id": 2, "question_id": 1, "content": "Another approach is...", "created_at": "..." }
  ]
}
```

---

### 5. Semantic Search (AI-Powered)

```
POST /search
Content-Type: application/json

Body: { "query": "How to handle cross-origin requests?" }

Response (close match from Q&A):
{
  "success": true,
  "fix": "To handle cross-origin requests in Express, install the cors package...",
  "source": "qa",
  "match": {
    "question_id": 1,
    "question": "How do I fix CORS errors in Express?",
    "distance": "0.1523",
    "answers_used": 2
  }
}

Response (close match from document chunks):
{
  "success": true,
  "fix": "Based on the uploaded documentation, CORS can be configured by...",
  "source": "document",
  "match": {
    "chunks_used": 3,
    "best_distance": "0.2104",
    "source_files": ["express-guide.pdf"]
  }
}

Response (no close match, distance >= 0.4):
{
  "success": true,
  "message": "No close match found (distance >= 0.4)",
  "best_question": { "question_id": 5, "question": "...", "distance": "0.5123" },
  "best_chunks": [
    { "chunk_id": 12, "source_filename": "guide.pdf", "distance": "0.4891", "preview": "..." }
  ]
}
```

**What it does:**
1. Converts the query to a Gemini embedding
2. Searches both Q&A pairs AND document chunks (from uploaded PDFs) in parallel
3. If distance < 0.4, sends the context to **Gemini 2.0 Flash** to synthesize a clear, human-readable answer
4. Returns the source type (qa or document) so the frontend knows where the answer came from

---

### 6. Upload PDF (Auto Q&A + Document Training)

```
POST /upload-pdf
Content-Type: multipart/form-data

Body: file = <pdf_file>

Response:
{
  "success": true,
  "message": "Processed PDF: 12 chunks trained, 15 Q&A pairs generated",
  "pdf_info": {
    "filename": "system-design-guide.pdf",
    "pages": 5,
    "characters_extracted": 12560
  },
  "chunks": {
    "total": 16,
    "saved": 16,
    "chunk_size": 1000,
    "overlap": 200
  },
  "generated_qa": [
    { "question_id": 10, "question": "What is load balancing?", "answer": "Load balancing is..." },
    { "question_id": 11, "question": "What is caching?", "answer": "Caching stores..." }
  ]
}
```

**What it does:**
1. Extracts text from the PDF
2. Chunks the entire document into overlapping 1000-char pieces and embeds each chunk
3. Uses Gemini AI to auto-generate 5-20 Q&A pairs from the content
4. Saves everything to the database — the document is now fully "trained"

**Max file size:** 20 MB

---

### 7. Get Statistics

```
GET /stats?type=summary

Query param `type`: "summary" (default) | "today" | "total" | "unanswered"

Response (summary):
{
  "success": true,
  "stat_type": "summary",
  "today": {
    "questions_registered": 5,
    "answers_added": 3
  },
  "total": {
    "questions": 42,
    "answers": 38
  },
  "unanswered": {
    "count": 4,
    "questions": [ { "id": 39, "content": "...", "created_at": "..." } ]
  },
  "recent_questions": [
    { "id": 42, "content": "Latest question?", "created_at": "..." }
  ]
}
```

---

## Frontend Pages / Sections

### 1. Dashboard (Home)
- Display stats cards: total questions, total answers, today's activity, unanswered count
- Recent questions list
- Animated counters for stats
- Call: `GET /stats?type=summary`

### 2. Semantic Search (Hero Section)
- Large search input with glowing border animation
- Real-time search via `POST /search`
- Display AI-synthesized answer in a styled card
- Show source badge: "From Q&A" (blue) or "From Document" (purple)
- Show similarity distance as a progress bar or percentage
- If no close match, show the best partial matches

### 3. Knowledge Base (Q&A Manager)
- List all questions with expandable answers — call `GET /questions`
- Click a question to expand and see answers — call `GET /answers/:id`
- "Add Question" button → modal → `POST /questions`
- "Add Answer" button on each question → inline form → `POST /answers`
- Search/filter questions locally

### 4. PDF Upload / Document Training
- Drag-and-drop file upload zone with animation
- Upload progress indicator
- After upload, show:
  - PDF info (pages, characters extracted)
  - Chunk stats (total chunks, chunk size, overlap)
  - Generated Q&A pairs in an expandable accordion
- Call: `POST /upload-pdf` (multipart/form-data)

### 5. Navigation
- Sidebar or top nav: Dashboard | Search | Knowledge Base | Upload PDF
- Active page indicator with glow effect

---

## UI Component Ideas

| Component | Style |
|-----------|-------|
| Cards | Glassmorphism: `backdrop-filter: blur(12px)`, semi-transparent bg, subtle border glow |
| Buttons | Gradient backgrounds (blue→purple), hover scale + glow |
| Search bar | Large, centered, glowing border on focus, pulsing placeholder animation |
| Stat cards | Animated number counters, icon + label, subtle gradient bg |
| File upload | Dashed border zone, icon animation on drag, progress ring |
| Q&A list | Accordion style, expand on click, answer cards nested inside |
| Badges | Small pill badges: "Q&A Source" (blue), "Document Source" (purple), distance score |
| Toast/Alert | Slide-in notifications for success/error states |
| Loading | Skeleton screens + shimmer effect, not spinners |

---

## Error Handling

All error responses follow this format:
```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

Handle these in the frontend with toast notifications or inline error messages.

---

## Tech Stack Suggestion

- **React 18+** with Vite
- **React Router** for navigation
- **Vanilla CSS** or **Tailwind CSS** (dark mode)
- **Lucide React** or **React Icons** for icons
- **Framer Motion** for animations
- **React Dropzone** for PDF upload
- **React Hot Toast** for notifications
- No state management library needed — React state + context is sufficient
