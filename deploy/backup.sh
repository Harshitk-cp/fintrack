#!/bin/sh
# Nightly dump of the compose.shared.yml database; keeps the last 14 days.
# crontab: 30 21 * * * $HOME/fintrack/deploy/backup.sh   (21:30 UTC = 03:00 IST)
set -e
dir="$HOME/fintrack-backups"
mkdir -p "$dir" && chmod 700 "$dir"
docker exec fintrack-db-1 pg_dump -U fintrack fintrack | gzip > "$dir/fintrack-$(date +%F).sql.gz"
find "$dir" -name 'fintrack-*.sql.gz' -mtime +14 -delete
