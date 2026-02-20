-- Enable pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Questions table with embedding support
CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    embedding vector(3072),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Answers table linked to questions
CREATE TABLE IF NOT EXISTS answers (
    id SERIAL PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Document chunks table for RAG training
CREATE TABLE IF NOT EXISTS document_chunks (
    id SERIAL PRIMARY KEY,
    source_filename TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding vector(3072),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Note: pgvector indexes (IVFFlat/HNSW) support max 2000 dimensions.
-- gemini-embedding-001 outputs 3072 dims, so we rely on sequential scan.
-- For large datasets, consider dimensionality reduction or approximate search.
