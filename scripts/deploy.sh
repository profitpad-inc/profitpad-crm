#!/usr/bin/env bash
# Updates ProfitPad's own server to what is on GitHub's main.
#
#   ./scripts/deploy.sh
#
# 1. checks that your main has nothing unpushed
# 2. waits for every GitHub Actions run on that commit (CI, Images) to finish,
#    and stops if any of them failed
# 3. runs install.sh on the server (pulls the new :main images, migrates,
#    restarts)
# 4. checks that every container on the server runs that commit
#
# DEPLOY_DRY_RUN=1 stops after step 2. DEPLOY_TIMEOUT_MIN (default 30) caps
# the wait. Needs gh (signed in) and the SSH alias profitpad_claude_profitpad_crm.
set -euo pipefail

repo=profitpad-inc/profitpad-crm
host=profitpad_claude_profitpad_crm
timeout_min=${DEPLOY_TIMEOUT_MIN:-30}

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")/.."
git fetch -q origin main
sha=$(git rev-parse origin/main)
short=${sha:0:7}
if [[ "$(git rev-parse HEAD)" != "$sha" ]]; then
  ahead=$(git rev-list --count origin/main..HEAD)
  [[ "$ahead" -eq 0 ]] || die "you have $ahead commit(s) not on GitHub yet; push first"
  say "note: your checkout is behind origin/main; deploying origin/main ($short)"
fi
say "deploying $short: $(git log -1 --format=%s "$sha")"

# Runs can take a few seconds to show up after a push, so wait for both.
deadline=$(( $(date +%s) + timeout_min * 60 ))
while :; do
  runs=$(gh run list --repo "$repo" --commit "$sha" --json databaseId,workflowName,status,conclusion \
    -q '.[] | "\(.workflowName)\t\(.status)\t\(.conclusion)\t\(.databaseId)"')
  have_images=$(grep -c '^Images	' <<<"$runs" || true)
  failed=$(awk -F'\t' '$2=="completed" && $3!="success" && $3!="skipped" {print $1" ("$3")"}' <<<"$runs")
  [[ -z "$failed" ]] || die "failed on GitHub: $failed  (gh run list --repo $repo --commit $short)"
  pending=$(awk -F'\t' '$2!="completed" {print $1}' <<<"$runs" | sort -u | paste -sd, -)
  if [[ "$have_images" -gt 0 && -z "$pending" ]]; then
    say "GitHub: all runs passed"
    break
  fi
  (( $(date +%s) < deadline )) || die "still waiting after $timeout_min minutes (${pending:-no Images run yet}); check the Actions tab"
  status_line="waiting for ${pending:-the Images run to start}"
  [[ "$status_line" == "${last:-}" ]] || say "$status_line"
  last=$status_line
  sleep 15
done

[[ -z "${DEPLOY_DRY_RUN:-}" ]] || { say "dry run: not touching the server"; exit 0; }
say "updating the server"
ssh -o ClearAllForwardings=yes "$host" "cd /opt/profitpad-crm && sudo bash install.sh" </dev/null

say "checking the containers"
bad=0
for s in api web migrate renderer; do
  rev=$(ssh -o ClearAllForwardings=yes "$host" \
    "sudo docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' pc-$s" </dev/null)
  if [[ "$rev" == "$sha" ]]; then
    say "  $s $short"
  else
    say "  $s ${rev:0:7} (expected $short)"
    bad=1
  fi
done
[[ $bad -eq 0 ]] || die "some containers are not on $short"
say "done: the server runs $short"
