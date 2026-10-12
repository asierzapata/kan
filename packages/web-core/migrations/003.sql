CREATE TABLE IF NOT EXISTS web_meeting_sessions(
  id uuid PRIMARY KEY, canvas uuid REFERENCES web_canvases(id), thread uuid REFERENCES web_threads(id),
  source text NOT NULL CHECK(source IN ('synthetic')), label text NOT NULL,
  status text NOT NULL DEFAULT 'listening' CHECK(status IN ('listening','paused','ended')),
  pause_reason text, created_by text NOT NULL,
  pending_cursor integer NOT NULL DEFAULT 0, processed_cursor integer NOT NULL DEFAULT 0,
  context_runs integer NOT NULL DEFAULT 0, last_segment_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
CREATE INDEX IF NOT EXISTS web_meeting_sessions_canvas ON web_meeting_sessions(canvas,status);
CREATE TABLE IF NOT EXISTS web_transcript_segments(
  session uuid REFERENCES web_meeting_sessions(id), source_id text NOT NULL, seq integer NOT NULL,
  speaker text NOT NULL, text text NOT NULL, started_at_ms integer NOT NULL, ended_at_ms integer,
  final boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session,source_id), UNIQUE(session,seq));
ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'request' CHECK(kind IN ('request','context'));
ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS meeting_session uuid;
ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS context_from integer;
ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS context_to integer;
ALTER TABLE web_messages ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]';
