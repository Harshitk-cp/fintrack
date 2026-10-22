-- Bank alert emails, read over IMAP with an app password.

alter table transactions drop constraint transactions_source_check;
alter table transactions add constraint transactions_source_check check (source in ('sms', 'email', 'manual'));

-- Each user can connect several mailboxes. The app password is sealed with the data key and never returned.
create table mail_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users on delete cascade,
  address          text not null,
  host             text not null,
  port             int not null default 993,
  password_enc     bytea not null,
  uid_validity     bigint,            -- IMAP UIDVALIDITY of INBOX; a change means UIDs were renumbered
  last_uid         bigint not null default 0,
  status           text not null default 'pending' check (status in ('pending', 'ok', 'auth_failed', 'error')),
  last_error       text,
  last_checked_at  timestamptz,
  emails_found     int not null default 0,  -- bank emails read so far
  created_at       timestamptz not null default now(),
  unique (user_id, address)
);
