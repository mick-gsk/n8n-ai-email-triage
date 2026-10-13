-- Run once in the database before the first ingest (psql -f setup.sql, or the SQL editor of your
-- Postgres host). Safe to run again.
CREATE EXTENSION IF NOT EXISTS vector;

-- Document chunks. The layout is the one n8n's PGVector Store node expects; 1536 is the
-- dimension of text-embedding-3-small. Another embedding model needs a different dimension
-- and a fresh table.
CREATE TABLE IF NOT EXISTS support_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text,
  metadata jsonb,
  embedding vector(1536)
);
-- Re-ingesting a file deletes its old chunks by file id.
CREATE INDEX IF NOT EXISTS support_chunks_file_id ON support_chunks ((metadata ->> 'file_id'));

-- One row per chat message, for the rate limit. Holds the session id and a timestamp, nothing else.
CREATE TABLE IF NOT EXISTS support_chat_requests (
  session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_chat_requests_session ON support_chat_requests (session_id, created_at);
CREATE INDEX IF NOT EXISTS support_chat_requests_created ON support_chat_requests (created_at);
