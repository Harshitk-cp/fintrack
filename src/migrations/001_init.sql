-- Evidence (what a source told us) is kept separate from transactions (what
-- actually happened). One transaction can be supported by many evidence rows.

create table users (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text unique,
  time_zone   text not null default 'Asia/Kolkata',
  created_at  timestamptz not null default now()
);

-- Collectors (iOS Shortcut, Android app) authenticate with a per-device token.
create table devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users on delete cascade,
  name          text not null,
  platform      text not null check (platform in ('ios', 'android', 'other')),
  token_hash    bytea not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

create table accounts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users on delete cascade,
  institution  text not null,
  kind         text not null check (kind in ('bank_account', 'credit_card', 'debit_card', 'unknown')),
  last4        text not null,
  nickname     text,
  created_at   timestamptz not null default now(),
  unique (user_id, institution, last4)
);

create table evidence (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users on delete cascade,
  device_id        uuid references devices on delete set null,
  source_type      text not null check (source_type in ('sms', 'email', 'notification', 'statement', 'manual')),
  source_id        text,
  sender           text,
  observed_at      timestamptz not null,           -- when the device received it
  ingested_at      timestamptz not null default now(),
  occurred_at      timestamptz,                    -- transaction time, if the source states it
  content_hash     bytea not null,
  raw_content_enc  bytea,                          -- AES-GCM sealed; nulled after retention_until
  retention_until  timestamptz,
  parser           text,
  parsed           jsonb,
  status           text not null check (status in ('new', 'linked', 'ignored', 'unrecognized', 'ambiguous')),
  status_reason    text,
  unique (user_id, content_hash)
);
create index evidence_status_idx on evidence (user_id, status);
create index evidence_retention_idx on evidence (retention_until) where raw_content_enc is not null;

create table transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users on delete cascade,
  account_id        uuid references accounts on delete set null,
  amount_minor      bigint not null check (amount_minor > 0),  -- paise
  currency          char(3) not null default 'INR',
  direction         text not null check (direction in ('debit', 'credit')),
  event_type        text not null default 'unknown'
                    check (event_type in ('purchase', 'transfer', 'income', 'refund', 'fee',
                                          'card_payment', 'cash_withdrawal', 'unknown')),
  status            text not null default 'posted' check (status in ('pending', 'posted', 'reversed', 'unknown')),
  channel           text not null default 'unknown' check (channel in ('upi', 'card', 'bank_transfer', 'atm', 'unknown')),
  occurred_at       timestamptz not null,
  counterparty      text,
  counterparty_vpa  text,
  reference         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index transactions_user_time_idx on transactions (user_id, occurred_at desc);
-- A refund/reversal may reuse the original reference, hence direction in the key.
create unique index transactions_reference_idx on transactions (user_id, reference, direction) where reference is not null;

create table transaction_evidence (
  transaction_id  uuid not null references transactions on delete cascade,
  evidence_id     uuid not null unique references evidence on delete cascade,
  match_method    text not null check (match_method in ('created', 'reference', 'heuristic', 'manual')),
  created_at      timestamptz not null default now(),
  primary key (transaction_id, evidence_id)
);
