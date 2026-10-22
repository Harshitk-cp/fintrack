-- Firebase Cloud Messaging tokens for Android phones. A token belongs to the
-- device (app install) that registered it and goes when that device signs out.
create table push_tokens (
  token       text primary key,
  user_id     uuid not null references users on delete cascade,
  device_id   uuid not null references devices on delete cascade,
  created_at  timestamptz not null default now(),
  last_error  text
);
create index push_tokens_user_idx on push_tokens (user_id);
