ALTER TABLE web_runs ADD COLUMN IF NOT EXISTS reverted_at timestamptz;
