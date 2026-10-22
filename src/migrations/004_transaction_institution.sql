-- The bank is known even when the SMS shows no account digits (e.g. "Acct XX789"),
-- so keep it on the transaction rather than only on accounts.
alter table transactions add column institution text;
alter table transactions add column institution_name text;

update transactions t
set institution = a.institution, institution_name = a.institution_name
from accounts a
where a.id = t.account_id;
