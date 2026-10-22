-- Sign-in with phone number + 4-digit PIN. The number is an identifier only
-- (never verified); brute force is held off by per-account lockouts.
alter table users add column phone text unique;
alter table users add column pin_hash text;
alter table users add column pin_failures int not null default 0;
alter table users add column pin_locked_until timestamptz;
