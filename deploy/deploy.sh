#!/bin/bash
# Pulls main and rebuilds the compose.shared.yml stack. GitHub Actions runs this
# over SSH with a key that authorized_keys pins to this script and nothing else.
# Wrapped in a function so bash parses it fully before `git reset` rewrites the file.
main() {
  set -euo pipefail
  cd "$HOME/fintrack"
  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  echo "deploying $(git log -1 --format='%h %s')"

  cd deploy
  docker compose -f compose.shared.yml up -d --build --remove-orphans
  docker image prune -f > /dev/null

  # Migrations run on startup; wait until the app answers through the proxy network.
  for _ in $(seq 1 30); do
    if docker exec engram-caddy wget -qO- http://fintrack-app:8080/healthz > /dev/null 2>&1; then
      echo "healthy"
      return 0
    fi
    sleep 2
  done
  echo "app did not become healthy; last logs:" >&2
  docker compose -f compose.shared.yml logs --tail 40 app >&2
  return 1
}
main "$@"
