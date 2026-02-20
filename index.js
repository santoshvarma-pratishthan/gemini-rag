import "dotenv/config";
import express from "express";
import pg from "pg";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";

// ── Configuration ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!DATABASE_URL) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
}
if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY environment variable is required");
    process.exit(1);
}

// ── Database ───────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function query(text, params = []) {
    const client = await pool.connect();
    try {
        return await client.query(text, params);
    } finally {
        client.release();
    }
}

// ── Gemini Embeddings (direct API call) ────────────────────────────────────────

async function generateEmbedding(text) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "models/gemini-embedding-001",
            content: { parts: [{ text }] },
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini Embedding API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.embedding.values;
}

function toSqlVector(arr) {
    return `[${arr.join(",")}]`;
}

/**
 * Split text into overlapping chunks for embedding.
 */
function chunkText(text, chunkSize = 1000, overlap = 200) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        chunks.push(text.slice(start, end));
        start += chunkSize - overlap;
    }
    return chunks;
}

/**
 * Call Gemini 2.0 Flash to generate a response from context.
 */
async function callGemini(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini LLM API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Unable to generate a response.";
}

/**
 * Synthesize a clear answer from Q&A answers.
 */
async function synthesizeAnswer(userQuery, question, answers) {
    const prompt = `You are a helpful assistant. A user asked:

"${userQuery}"

The most relevant question in our knowledge base is:
"${question}"

Recorded answers:
${answers.map((a, i) => `${i + 1}. ${a.content}`).join("\n")}

Provide a single clear, concise, and easy-to-understand response. Do not mention combining multiple answers.`;
    return callGemini(prompt);
}

/**
 * Synthesize a response from document chunk context.
 */
async function synthesizeFromChunks(userQuery, chunks) {
    const context = chunks.map((c, i) => `[Chunk ${i + 1} from ${c.source_filename}]:\n${c.content}`).join("\n\n");
    const prompt = `You are a helpful assistant. A user asked:

"${userQuery}"

Here are the most relevant sections from our knowledge base documents:

${context}

Based on the above context, provide a single clear, concise, and easy-to-understand answer to the user's query. Reference specific details from the documents.`;
    return callGemini(prompt);
}

// ── Swagger / OpenAPI Setup ────────────────────────────────────────────────────

const swaggerSpec = swaggerJsdoc({
    definition: {
        openapi: "3.0.0",
        info: {
            title: "Gemini RAG API",
            version: "1.0.0",
            description:
                "Q&A management API with PostgreSQL (pgvector) and Gemini semantic search",
        },
        servers: [{ url: `http://localhost:${PORT}` }],
    },
    apis: ["./index.js"],
});

// ── Express App ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @swagger
 * components:
 *   schemas:
 *     Question:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           example: 1
 *         content:
 *           type: string
 *           example: "How do I fix CORS errors in Express?"
 *         created_at:
 *           type: string
 *           format: date-time
 *     Answer:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           example: 1
 *         question_id:
 *           type: integer
 *           example: 1
 *         content:
 *           type: string
 *           example: "Use the cors middleware package."
 *         created_at:
 *           type: string
 *           format: date-time
 *     Error:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: false
 *         error:
 *           type: string
 */

// ── POST /questions — Register a question ──────────────────────────────────────

/**
 * @swagger
 * /questions:
 *   post:
 *     summary: Register a new question
 *     description: Takes a question string, generates a Gemini embedding, and saves both to the database.
 *     tags: [Questions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *                 example: "How do I fix CORS errors in Express?"
 *     responses:
 *       201:
 *         description: Question registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 question:
 *                   $ref: '#/components/schemas/Question'
 *       400:
 *         description: Missing content
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 */
app.post("/questions", async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) {
            return res.status(400).json({ success: false, error: "content is required" });
        }

        const embedding = await generateEmbedding(content);
        const vectorStr = toSqlVector(embedding);

        const result = await query(
            `INSERT INTO questions (content, embedding) VALUES ($1, $2) RETURNING id, content, created_at`,
            [content, vectorStr]
        );

        const row = result.rows[0];
        res.status(201).json({
            success: true,
            message: "Question registered successfully",
            question: { id: row.id, content: row.content, created_at: row.created_at },
        });
    } catch (error) {
        console.error("POST /questions error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── GET /questions — List all questions ────────────────────────────────────────

/**
 * @swagger
 * /questions:
 *   get:
 *     summary: List all questions
 *     description: Returns all registered questions ordered by most recent first.
 *     tags: [Questions]
 *     responses:
 *       200:
 *         description: List of questions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 questions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Question'
 */
app.get("/questions", async (req, res) => {
    try {
        const result = await query(
            `SELECT id, content, created_at FROM questions ORDER BY created_at DESC`
        );
        res.json({ success: true, questions: result.rows });
    } catch (error) {
        console.error("GET /questions error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── POST /answers — Add an answer to a question ───────────────────────────────

/**
 * @swagger
 * /answers:
 *   post:
 *     summary: Add an answer to a question
 *     description: Links an answer to a specific question by question_id.
 *     tags: [Answers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question_id, content]
 *             properties:
 *               question_id:
 *                 type: integer
 *                 example: 1
 *               content:
 *                 type: string
 *                 example: "Use the cors middleware package."
 *     responses:
 *       201:
 *         description: Answer added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 answer:
 *                   $ref: '#/components/schemas/Answer'
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Question not found
 */
app.post("/answers", async (req, res) => {
    try {
        const { question_id, content } = req.body;
        if (!question_id || !content) {
            return res
                .status(400)
                .json({ success: false, error: "question_id and content are required" });
        }

        const check = await query(`SELECT id FROM questions WHERE id = $1`, [question_id]);
        if (check.rows.length === 0) {
            return res
                .status(404)
                .json({ success: false, error: `Question with id ${question_id} not found` });
        }

        const result = await query(
            `INSERT INTO answers (question_id, content) VALUES ($1, $2) RETURNING id, question_id, content, created_at`,
            [question_id, content]
        );

        const row = result.rows[0];
        res.status(201).json({
            success: true,
            message: "Answer added successfully",
            answer: {
                id: row.id,
                question_id: row.question_id,
                content: row.content,
                created_at: row.created_at,
            },
        });
    } catch (error) {
        console.error("POST /answers error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── GET /answers/:question_id — Get answers for a question ─────────────────────

/**
 * @swagger
 * /answers/{question_id}:
 *   get:
 *     summary: Get answers for a question
 *     description: Returns all answers linked to a specific question.
 *     tags: [Answers]
 *     parameters:
 *       - in: path
 *         name: question_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The question ID
 *     responses:
 *       200:
 *         description: List of answers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 answers:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Answer'
 */
app.get("/answers/:question_id", async (req, res) => {
    try {
        const { question_id } = req.params;
        const result = await query(
            `SELECT a.id, a.content, a.created_at, q.content AS question
       FROM answers a
       JOIN questions q ON q.id = a.question_id
       WHERE a.question_id = $1
       ORDER BY a.created_at DESC`,
            [question_id]
        );
        res.json({ success: true, answers: result.rows });
    } catch (error) {
        console.error("GET /answers error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── POST /search — Semantic search ─────────────────────────────────────────────

/**
 * @swagger
 * /search:
 *   post:
 *     summary: Semantic search for questions
 *     description: >
 *       Takes a natural language query, converts it to a Gemini embedding,
 *       and performs cosine similarity search (<=>) in Postgres to find
 *       the most relevant question and its answers. If a match is found
 *       with distance < 0.4, returns the answer as a "fix".
 *     tags: [Search]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *                 example: "CORS error Express middleware"
 *     responses:
 *       200:
 *         description: Search result with closest matching question
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 fix:
 *                   type: string
 *                   description: Returned when distance < 0.4 and answers exist
 *                 match:
 *                   type: object
 *                   properties:
 *                     question_id:
 *                       type: integer
 *                     question:
 *                       type: string
 *                     distance:
 *                       type: string
 *                     is_close_match:
 *                       type: boolean
 *                     answers:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Answer'
 *       400:
 *         description: Missing query
 */
app.post("/search", async (req, res) => {
    try {
        const { query: searchQuery } = req.body;
        if (!searchQuery) {
            return res.status(400).json({ success: false, error: "query is required" });
        }

        const embedding = await generateEmbedding(searchQuery);
        const vectorStr = toSqlVector(embedding);

        // Search both questions AND document chunks in parallel
        const [qResult, chunkResult] = await Promise.all([
            query(
                `SELECT id, content, embedding <=> $1::vector AS distance, 'question' AS source_type
                 FROM questions
                 ORDER BY embedding <=> $1::vector ASC
                 LIMIT 1`,
                [vectorStr]
            ),
            query(
                `SELECT id, content, source_filename, chunk_index,
                        embedding <=> $1::vector AS distance, 'chunk' AS source_type
                 FROM document_chunks
                 ORDER BY embedding <=> $1::vector ASC
                 LIMIT 3`,
                [vectorStr]
            ),
        ]);

        const bestQuestion = qResult.rows[0] || null;
        const bestChunks = chunkResult.rows || [];
        const qDistance = bestQuestion ? parseFloat(bestQuestion.distance) : Infinity;
        const chunkDistance = bestChunks.length > 0 ? parseFloat(bestChunks[0].distance) : Infinity;

        // Decide which source has the best match
        const bestSource = qDistance <= chunkDistance ? "question" : "chunk";
        const bestDistance = Math.min(qDistance, chunkDistance);

        if (bestDistance < 0.4) {
            let synthesized;

            if (bestSource === "question" && bestQuestion) {
                // Get all answers for the matched question
                const aResult = await query(
                    `SELECT id, content, created_at FROM answers
                     WHERE question_id = $1 ORDER BY created_at ASC`,
                    [bestQuestion.id]
                );

                if (aResult.rows.length > 0) {
                    synthesized = await synthesizeAnswer(
                        searchQuery, bestQuestion.content, aResult.rows
                    );
                } else {
                    // No answers but close Q match — try chunks as fallback
                    synthesized = bestChunks.length > 0
                        ? await synthesizeFromChunks(searchQuery, bestChunks)
                        : `Matched question: "${bestQuestion.content}" — but no answers available yet.`;
                }

                return res.json({
                    success: true,
                    fix: synthesized,
                    source: "qa",
                    match: {
                        question_id: bestQuestion.id,
                        question: bestQuestion.content,
                        distance: qDistance.toFixed(4),
                        answers_used: aResult.rows.length,
                    },
                });
            } else if (bestChunks.length > 0) {
                // Best match is from document chunks
                synthesized = await synthesizeFromChunks(searchQuery, bestChunks);

                return res.json({
                    success: true,
                    fix: synthesized,
                    source: "document",
                    match: {
                        chunks_used: bestChunks.length,
                        best_distance: chunkDistance.toFixed(4),
                        source_files: [...new Set(bestChunks.map(c => c.source_filename))],
                    },
                });
            }
        }

        // No close match — return raw results
        res.json({
            success: true,
            message: "No close match found (distance >= 0.4)",
            best_question: bestQuestion ? {
                question_id: bestQuestion.id,
                question: bestQuestion.content,
                distance: qDistance.toFixed(4),
            } : null,
            best_chunks: bestChunks.map(c => ({
                chunk_id: c.id,
                source_filename: c.source_filename,
                distance: parseFloat(c.distance).toFixed(4),
                preview: c.content.slice(0, 200) + "...",
            })),
        });
    } catch (error) {
        console.error("POST /search error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── GET /stats — Database statistics ───────────────────────────────────────────

/**
 * @swagger
 * /stats:
 *   get:
 *     summary: Get database statistics
 *     description: >
 *       Returns metadata stats like "How many questions were registered today?"
 *       using standard SQL queries.
 *     tags: [Stats]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [today, total, unanswered, summary]
 *           default: summary
 *         description: "Type of stats to retrieve"
 *     responses:
 *       200:
 *         description: Statistics result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stat_type:
 *                   type: string
 *                 today:
 *                   type: object
 *                   properties:
 *                     questions_registered:
 *                       type: integer
 *                     answers_added:
 *                       type: integer
 *                 total:
 *                   type: object
 *                   properties:
 *                     questions:
 *                       type: integer
 *                     answers:
 *                       type: integer
 *                 unanswered:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     questions:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Question'
 *                 recent_questions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Question'
 */
app.get("/stats", async (req, res) => {
    try {
        const statType = req.query.type || "summary";
        let stats = {};

        if (statType === "today" || statType === "summary") {
            const todayQ = await query(
                `SELECT COUNT(*) AS count FROM questions WHERE created_at::date = CURRENT_DATE`
            );
            const todayA = await query(
                `SELECT COUNT(*) AS count FROM answers WHERE created_at::date = CURRENT_DATE`
            );
            stats.today = {
                questions_registered: parseInt(todayQ.rows[0].count),
                answers_added: parseInt(todayA.rows[0].count),
            };
        }

        if (statType === "total" || statType === "summary") {
            const totalQ = await query(`SELECT COUNT(*) AS count FROM questions`);
            const totalA = await query(`SELECT COUNT(*) AS count FROM answers`);
            stats.total = {
                questions: parseInt(totalQ.rows[0].count),
                answers: parseInt(totalA.rows[0].count),
            };
        }

        if (statType === "unanswered" || statType === "summary") {
            const unanswered = await query(
                `SELECT q.id, q.content, q.created_at
         FROM questions q
         LEFT JOIN answers a ON a.question_id = q.id
         WHERE a.id IS NULL
         ORDER BY q.created_at DESC
         LIMIT 10`
            );
            stats.unanswered = { count: unanswered.rows.length, questions: unanswered.rows };
        }

        if (statType === "summary") {
            const recent = await query(
                `SELECT id, content, created_at FROM questions ORDER BY created_at DESC LIMIT 5`
            );
            stats.recent_questions = recent.rows;
        }

        res.json({ success: true, stat_type: statType, ...stats });
    } catch (error) {
        console.error("GET /stats error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── PDF Upload Setup ───────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * Use Gemini to generate Q&A pairs from extracted PDF text.
 */
async function generateQAPairs(text) {
    // Truncate to ~30k chars to stay within Gemini context limits
    const truncated = text.slice(0, 30000);

    const prompt = `You are an expert knowledge extractor. Analyze the following document text and generate a comprehensive set of question-and-answer pairs that capture all the key information.

Rules:
- Generate between 5 and 20 Q&A pairs depending on the content length and richness.
- Questions should be specific, useful, and cover all important topics in the document.
- Answers should be concise but complete, using information directly from the text.
- Return ONLY a valid JSON array, no markdown fences, no extra text.
- Format: [{"question": "...", "answer": "..."}]

Document text:
${truncated}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3 },
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini LLM API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    // Clean potential markdown fences
    const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
}

// ── POST /upload-pdf — Upload PDF and auto-generate Q&A ────────────────────────

/**
 * @swagger
 * /upload-pdf:
 *   post:
 *     summary: Upload a PDF and auto-generate Q&A pairs
 *     description: >
 *       Extracts text from an uploaded PDF, uses Gemini to generate
 *       question-answer pairs from the content, generates embeddings
 *       for each question, and saves everything to the database.
 *     tags: [PDF]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: PDF file to process
 *     responses:
 *       200:
 *         description: Document chunked, trained, and Q&A pairs generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 pdf_info:
 *                   type: object
 *                 chunks:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     saved:
 *                       type: integer
 *                 generated_qa:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       question_id:
 *                         type: integer
 *                       question:
 *                         type: string
 *                       answer:
 *                         type: string
 *       400:
 *         description: No file uploaded or invalid file type
 *       500:
 *         description: Server error
 */
app.post("/upload-pdf", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "No file uploaded. Use form field name 'file'." });
        }

        if (req.file.mimetype !== "application/pdf") {
            return res.status(400).json({ success: false, error: "Only PDF files are accepted." });
        }

        // Step 1: Extract text from PDF
        console.log(`Processing PDF: ${req.file.originalname} (${req.file.size} bytes)`);
        const dataBuffer = req.file.buffer;
        const pdfData = await pdf(dataBuffer);
        const extractedText = pdfData.text;

        if (!extractedText || extractedText.trim().length < 50) {
            return res.status(400).json({
                success: false,
                error: "Could not extract sufficient text from the PDF.",
            });
        }

        console.log(`Extracted ${extractedText.length} characters from ${pdfData.numpages} pages`);

        // Step 2: Chunk the full document and embed each chunk
        console.log("Chunking document and generating embeddings...");
        const chunks = chunkText(extractedText, 1000, 200);
        let chunksSaved = 0;

        for (let i = 0; i < chunks.length; i++) {
            try {
                const embedding = await generateEmbedding(chunks[i]);
                const vectorStr = toSqlVector(embedding);
                await query(
                    `INSERT INTO document_chunks (source_filename, chunk_index, content, embedding)
                     VALUES ($1, $2, $3, $4)`,
                    [req.file.originalname, i, chunks[i], vectorStr]
                );
                chunksSaved++;
            } catch (chunkError) {
                console.error(`Failed to save chunk ${i}:`, chunkError.message);
            }
        }
        console.log(`Saved ${chunksSaved}/${chunks.length} chunks`);

        // Step 3: Generate Q&A pairs using Gemini
        console.log("Generating Q&A pairs with Gemini...");
        const qaPairs = await generateQAPairs(extractedText);
        console.log(`Generated ${qaPairs.length} Q&A pairs`);

        // Step 4: Save each Q&A pair to the database
        const savedQA = [];
        for (const pair of qaPairs) {
            try {
                const embedding = await generateEmbedding(pair.question);
                const vectorStr = toSqlVector(embedding);

                const qResult = await query(
                    `INSERT INTO questions (content, embedding) VALUES ($1, $2) RETURNING id, content, created_at`,
                    [pair.question, vectorStr]
                );
                const questionRow = qResult.rows[0];

                const aResult = await query(
                    `INSERT INTO answers (question_id, content) VALUES ($1, $2) RETURNING id, content, created_at`,
                    [questionRow.id, pair.answer]
                );

                savedQA.push({
                    question_id: questionRow.id,
                    question: questionRow.content,
                    answer: aResult.rows[0].content,
                });
            } catch (pairError) {
                console.error(`Failed to save Q&A pair: "${pair.question}"`, pairError.message);
            }
        }

        res.json({
            success: true,
            message: `Processed PDF: ${chunksSaved} chunks trained, ${savedQA.length} Q&A pairs generated`,
            pdf_info: {
                filename: req.file.originalname,
                pages: pdfData.numpages,
                characters_extracted: extractedText.length,
            },
            chunks: {
                total: chunks.length,
                saved: chunksSaved,
                chunk_size: 1000,
                overlap: 200,
            },
            generated_qa: savedQA,
        });
    } catch (error) {
        console.error("POST /upload-pdf error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Start Server ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`🚀 Gemini RAG Server running at http://localhost:${PORT}`);
    console.log(`📚 Swagger docs at http://localhost:${PORT}/api-docs`);
});
