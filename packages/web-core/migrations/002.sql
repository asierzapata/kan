ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS qa_fault_pending boolean NOT NULL DEFAULT false;
ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS qa_fault_exercised boolean NOT NULL DEFAULT false;

ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS auth_session_id text;
ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
