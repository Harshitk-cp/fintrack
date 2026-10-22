-- Display name for any bank, including ones without a dedicated parser.
alter table accounts add column institution_name text;

-- Unrecognized SMS are retried through the LLM fallback in the background.
alter table evidence add column llm_attempts int not null default 0;
alter table evidence add column llm_claimed_at timestamptz;
alter table evidence add column llm_error text;
create index evidence_llm_queue_idx on evidence (ingested_at)
  where status = 'unrecognized' and raw_content_enc is not null;
