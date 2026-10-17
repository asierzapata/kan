DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
             WHERE c.conname='web_events_pkey' AND a.attname='revision')
  THEN ALTER TABLE web_events DROP CONSTRAINT web_events_pkey; END IF;
END $$;
ALTER TABLE web_events ADD COLUMN IF NOT EXISTS seq bigserial;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='web_events_pkey') THEN ALTER TABLE web_events ADD PRIMARY KEY(room, seq); END IF; END $$;
CREATE INDEX IF NOT EXISTS web_events_room_revision ON web_events(room, revision);
