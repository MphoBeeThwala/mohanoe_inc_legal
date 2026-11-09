#!/usr/bin/env bash
# Deploys an image to one environment: run migrations with it, point every
# scheduled job at it, roll the API to it, and check /ready through Front
# Door. Stops at the first failure (the previous API revision keeps serving).
#
# Usage: RESOURCE_GROUP=… API_APP=… JOB_PREFIX=… PUBLIC_URL=… deploy-azure.sh <image>
set -euo pipefail

image="${1:?image}"
: "${RESOURCE_GROUP:?}" "${API_APP:?}" "${JOB_PREFIX:?}" "${PUBLIC_URL:?}"

echo "Migrating with ${image}"
az containerapp job update -g "$RESOURCE_GROUP" -n "${JOB_PREFIX}-migrate" --image "$image" >/dev/null
execution=$(az containerapp job start -g "$RESOURCE_GROUP" -n "${JOB_PREFIX}-migrate" --query name -o tsv)
for _ in $(seq 1 90); do
  status=$(az containerapp job execution show -g "$RESOURCE_GROUP" -n "${JOB_PREFIX}-migrate" \
    --job-execution-name "$execution" --query properties.status -o tsv)
  case "$status" in
    Succeeded) echo "Migrations applied."; break ;;
    Failed | Stopped | Degraded) echo "Migration ${status}"; exit 1 ;;
  esac
  sleep 10
done
[ "${status:-}" = "Succeeded" ] || { echo "Migration timed out"; exit 1; }

for job in anchor reminders court-rolls domains subscriptions; do
  az containerapp job update -g "$RESOURCE_GROUP" -n "${JOB_PREFIX}-${job}" --image "$image" >/dev/null
done

echo "Rolling the API to ${image}"
az containerapp update -g "$RESOURCE_GROUP" -n "$API_APP" --image "$image" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "${PUBLIC_URL%/}/ready" | grep -q '"database":true'; then
    echo "Ready."
    exit 0
  fi
  sleep 10
done
echo "The API did not become ready through Front Door."
exit 1
