-- Short-lived codes so a phone can be paired without typing a long device token.
-- The token itself is minted only when the code is redeemed.
create table pairing_codes (
  code_hash    bytea primary key,
  user_id      uuid not null references users on delete cascade,
  device_name  text not null,
  platform     text not null check (platform in ('ios', 'android', 'other')),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  device_id    uuid references devices on delete set null
);
