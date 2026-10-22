-- Categories, manual entries, the review queue, payee rules, notifications and
-- per-user alert settings.

alter table users
  add column alert_min_minor       bigint not null default 50000 check (alert_min_minor >= 0),  -- ₹500
  add column digest_hour           smallint not null default 21 check (digest_hour between 0 and 23),
  add column monthly_budget_minor  bigint check (monthly_budget_minor > 0),
  add column push_topic            text unique;  -- secret ntfy topic; null = push off

alter table transactions drop constraint transactions_channel_check;
alter table transactions add constraint transactions_channel_check
  check (channel in ('upi', 'card', 'bank_transfer', 'atm', 'cash', 'unknown'));

alter table transactions
  add column source           text not null default 'sms' check (source in ('sms', 'manual')),
  add column category         text,
  add column category_source  text check (category_source in ('user', 'rule', 'builtin')),
  add column label            text,     -- user's name for the payee, shown instead of counterparty
  add column note             text,
  add column excluded         boolean not null default false,  -- left out of all totals
  add column review_reason    text,     -- why we ask the user about it; null = nothing to ask
  add column reviewed_at      timestamptz,
  add column notified_at      timestamptz;

-- Existing rows predate alerts; don't announce them.
update transactions set notified_at = now();

create index transactions_review_idx on transactions (user_id, occurred_at desc)
  where review_reason is not null and reviewed_at is null;
create index transactions_unnotified_idx on transactions (created_at) where notified_at is null;

-- "Always treat this payee as X", learned from review answers.
create table payee_rules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users on delete cascade,
  match_kind   text not null check (match_kind in ('vpa', 'name')),
  match_value  text not null,  -- lowercased
  label        text,
  category     text,
  event_type   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, match_kind, match_value)
);

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users on delete cascade,
  kind            text not null check (kind in ('transaction', 'review', 'digest', 'budget')),
  title           text not null,
  body            text not null,
  transaction_id  uuid references transactions on delete cascade,
  dedupe_key      text,
  created_at      timestamptz not null default now(),
  read_at         timestamptz,
  pushed_at       timestamptz,
  push_attempts   smallint not null default 0,
  push_error      text,
  unique (user_id, dedupe_key)
);
create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_push_idx on notifications (created_at) where pushed_at is null;
