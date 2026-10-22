-- Salary, SIPs and savings, and calm "pace" check-ins.

-- Monthly take-home pay, asked at sign-up (optional). Home shows spending against it.
alter table users add column monthly_income_minor bigint check (monthly_income_minor is null or monthly_income_minor > 0);

-- Pace check-ins written by the assistant land in the same inbox.
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('transaction', 'review', 'digest', 'budget', 'insight'));

-- Systematic investment plans. Added by the user, or from a bank/fund alert the assistant understood.
create table sips (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users on delete cascade,
  name          text not null,
  amount_minor  bigint not null check (amount_minor > 0),
  day_of_month  int check (day_of_month between 1 and 31),  -- usual debit day, if known
  source        text not null default 'manual' check (source in ('manual', 'detected')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index sips_user_idx on sips (user_id);
create unique index sips_user_name_idx on sips (user_id, lower(name));

-- One row per SIP per month it was paid; counts as savings.
create table sip_payments (
  sip_id          uuid not null references sips on delete cascade,
  month           char(7) not null,  -- YYYY-MM in the user's time zone
  amount_minor    bigint not null check (amount_minor > 0),
  paid_at         timestamptz not null default now(),
  transaction_id  uuid references transactions on delete set null,
  primary key (sip_id, month)
);

-- An alert that mentions a SIP. The assistant reads it; anything it can't pin down goes to the user.
create table sip_suggestions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users on delete cascade,
  evidence_id     uuid not null unique references evidence on delete cascade,
  transaction_id  uuid references transactions on delete set null,
  scheme          text,
  amount_minor    bigint,
  status          text not null default 'new' check (status in ('new', 'matched', 'needs_user', 'added', 'dismissed')),
  attempts        int not null default 0,
  created_at      timestamptz not null default now()
);
create index sip_suggestions_open_idx on sip_suggestions (user_id) where status in ('new', 'needs_user');
