- Read `HANDOFF.md` before starting any task.
- Do not run the preview or verify changes in the browser unless the user explicitly asks.

## Releasing and deploying

Follow these steps in order whenever the user asks to commit, push, release or deploy. Skip only the steps they did not ask for.

1. **Check migration numbers.** `ls db/migrations | tail`. Every new file needs its own number, the next one after the highest. Two files must never share a number. If they do, renumber the one that has not run on live yet. Check with `psql -h localhost -p 5433 -U pc_migrator -d profitpad_crm_db -Atc "select filename from meta.migrations order by filename desc limit 5"`. Migrations are tracked by filename, so never rename one that has already run there. Update every comment and doc that names the old number (`grep -rn "<old number>" api web db docs HANDOFF.md`).
2. **Run the checks.** `cd api && npm run typecheck && npm test`, `cd web && npm run build`, `./db/test-local.sh`. Stop if any fail.
3. **Commit and push main.** `git push origin main`.
4. **Pick the version.** `git tag --sort=-v:refname | head -1`, then bump the patch number (v0.2.26 -> v0.2.27) unless the user says otherwise.
5. **Tag and push the tag. Never run `gh release create`.** `git tag vX.Y.Z <commit> && git push origin vX.Y.Z`. Pushing the tag starts the Images workflow, whose `release` job creates the GitHub release itself, with `docker-compose.yml` and `install.sh` attached. If a release already exists, that job fails and `./scripts/deploy.sh` stops on the failure.
6. **Wait for the release.** `gh run list --repo profitpad-inc/profitpad-crm --branch vX.Y.Z`, then `gh run watch <id> --repo profitpad-inc/profitpad-crm --exit-status`. Confirm the assets: `gh release view vX.Y.Z --repo profitpad-inc/profitpad-crm --json assets -q '.assets[].name'` should list `docker-compose.yml` and `install.sh`.
   - Recovery if a release was created by hand: `gh release delete vX.Y.Z --repo profitpad-inc/profitpad-crm --yes` (the tag stays), then `gh run rerun <id> --repo profitpad-inc/profitpad-crm --failed`.
7. **Destructive migrations** (retyping columns, deleting data or properties): ask the user before deploying, then back up both databases:
   - Live: `/opt/homebrew/opt/libpq/bin/pg_dump -h localhost -p 5433 -U pc_migrator -d profitpad_crm_db -Fc -f backups/profitpad_crm_db_pre_<what>_$(date +%Y%m%d_%H%M%S).dump`
   - Defense: `ssh -o ClearAllForwardings=yes profitpad_claude_profitpad_crm 'docker exec pc-defense-db sh -c "pg_dump -U \${POSTGRES_USER:-postgres} -d profitpad_crm_db -Fc"' > backups/profitpad_defense_crm_pre_<what>_$(date +%Y%m%d_%H%M%S).dump`
   - Check that each dump has data: `/opt/homebrew/opt/libpq/bin/pg_restore -l <file> | grep -c 'TABLE DATA crm'`.
8. **Deploy.** `./scripts/deploy.sh` deploys origin/main to the live CRM (crm.profitpad.com). `./scripts/deploy.sh defense` deploys the newest release to the defense CRM (crm.defense.profitpad.com). Each one waits for CI and Images and stops if either failed. The live deploy also waits on the tag's Images run when main and the tag are on the same commit, so do step 6 first. Run each in the foreground with a 10 minute timeout.
9. **Verify.** Each deploy ends with `done: <target> runs <commit>`. Check that the new migrations ran on both databases (the `meta.migrations` query from step 1 for live, the same query through `docker exec pc-defense-db psql` for defense). Check that both sites return 200 (`curl -s -o /dev/null -w '%{http_code}' <url>`).
10. **Record it** in `HANDOFF.md` under "Where we're at": the version, the commits, the backups and what was verified.
