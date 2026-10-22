-- Clean payee names and categories suggested by the model, kept apart from the
-- user's own label so a name the user gives always wins.
alter table transactions add column ai_name text;
alter table transactions add column named_at timestamptz;  -- null: not looked at by the namer yet

alter table transactions drop constraint transactions_category_source_check;
alter table transactions add constraint transactions_category_source_check check (category_source in ('user', 'rule', 'builtin', 'ai'));

-- One lookup per payee: later payments to the same UPI ID or merchant reuse the answer.
create table payee_names (
  user_id     uuid not null references users on delete cascade,
  key         text not null,               -- "vpa:<upi id>" or "name:<normalised merchant>"
  name        text,
  kind        text not null check (kind in ('merchant', 'person', 'self', 'unknown')),
  category    text,
  confident   boolean not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, key)
);

-- Manual entries are named by the user already.
update transactions set named_at = now() where source = 'manual';
