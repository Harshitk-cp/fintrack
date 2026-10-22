-- The "connect your bank emails" banner. It shows until dismissed; it comes back
-- 1 day after the first dismissal and 7 days after the second, then never again.
alter table users add column mail_nudge_dismissals int not null default 0;
alter table users add column mail_nudge_next_at timestamptz;  -- null: show now (if not dismissed for good)
