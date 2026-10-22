-- Per-category budgets, refunds linked to the purchase they pay back, and
-- subscriptions the user said aren't subscriptions.

-- A monthly limit for one category. Nudges go out at 80% and 100%.
create table category_budgets (
  user_id       uuid not null references users on delete cascade,
  category      text not null,
  amount_minor  bigint not null check (amount_minor > 0),
  created_at    timestamptz not null default now(),
  primary key (user_id, category)
);

-- Money back for a purchase. The purchase then counts at its amount minus its
-- refunds, in the month it was made. When the refund's own credit is linked, that
-- credit no longer counts as money received (it's already netted off the purchase).
create table refunds (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users on delete cascade,
  purchase_id      uuid not null references transactions on delete cascade,
  refund_txn_id    uuid references transactions on delete set null,
  amount_minor     bigint not null check (amount_minor > 0),
  created_at       timestamptz not null default now()
);
create index refunds_purchase_idx on refunds (purchase_id);
create unique index refunds_credit_idx on refunds (refund_txn_id) where refund_txn_id is not null;

-- Recurring charges the user hid from the subscriptions list, by payee key.
create table subscription_hides (
  user_id     uuid not null references users on delete cascade,
  payee_key   text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, payee_key)
);
