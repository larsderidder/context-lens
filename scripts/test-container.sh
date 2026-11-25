#!/usr/bin/env bash
set -euo pipefail

image="${1:-context-lens:test}"
docker build --tag "$image" .
container=$(docker run --detach --rm "$image" node dist/analysis/server.js)
trap 'docker rm --force "$container" >/dev/null' EXIT

for attempt in {1..30}; do
  if docker exec --interactive "$container" node --input-type=module < scripts/check-container.mjs; then
    exit 0
  fi
  sleep 1
done

docker logs "$container"
exit 1
