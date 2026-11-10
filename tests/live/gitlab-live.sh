#!/usr/bin/env bash
# Live GitLab test: runs the guard, the merge logger and forge detection against
# a real GitLab instance (gitlab.com or self-hosted) through the real `glab`.
# Opt-in; `node tests/run.js` never runs it.
#
#   GITLAB_TEST_PROJECT=group/scratch bash tests/live/gitlab-live.sh
#
# Needs: git, node 18+, and a current glab logged in to the project's host
# (`glab auth login --hostname <host>`). Use a throwaway project you can push
# to and merge in: the test makes three branches named *-live-<timestamp>,
# opens two MRs, merges one into its own milestone branch, and deletes the
# branches and closes the other MR at the end. It never touches main: a branch
# live-main-<timestamp> stands in for it and is marked protected for the guard.
set -u

PROJECT="${GITLAB_TEST_PROJECT:-}"
if [ -z "$PROJECT" ]; then
  echo "Set GITLAB_TEST_PROJECT to a throwaway project, e.g. GITLAB_TEST_PROJECT=group/scratch"
  exit 2
fi
for bin in git node glab; do
  command -v "$bin" >/dev/null || { echo "SKIP: $bin not on PATH"; exit 2; }
done
if ! glab mr view --help 2>&1 | grep -q -- '--output'; then
  echo "FAIL: this glab has no 'mr view --output json' ($(glab version 2>&1 | head -1)). Update glab."
  exit 1
fi

PLUGIN="$(cd "$(dirname "$0")/../.." && pwd)"
TS="$(date +%Y%m%d%H%M%S)"
MAIN="live-main-$TS"
MS="milestone/live-$TS"
TASK="task/live-$TS"
TMP="$(mktemp -d)"
REPO="$TMP/repo"
MR_A="" MR_B=""
PASS=0 FAIL=0
ROWS=()

row() { # row <PASS|FAIL> <name> [detail]
  ROWS+=("$1  $2${3:+ — $3}")
  if [ "$1" = PASS ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
}

cleanup() {
  set +e
  if [ -d "$REPO/.git" ]; then
    cd "$REPO"
    [ -n "$MR_B" ] && glab mr close "$MR_B" >/dev/null 2>&1
    [ -n "$MR_A" ] && glab mr close "$MR_A" >/dev/null 2>&1
    for b in "$TASK" "$MS" "$MAIN"; do git push -q origin --delete "$b" >/dev/null 2>&1; done
  fi
  cd / && rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Run a hook script with a JSON event on stdin, from the test repo.
hook() { # hook <script> <event-json>
  (cd "$REPO" && printf '%s' "$2" | CLAUDE_PROJECT_DIR="$REPO" CLAUDE_PLUGIN_ROOT="$PLUGIN" \
    AGENT_TEAM_PROTECTED_BRANCHES="main,master,$MAIN" node "$PLUGIN/scripts/$1")
}
guard_event() { node -e 'process.stdout.write(JSON.stringify({hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:process.argv[1]},cwd:process.argv[2]}))' "$1" "$REPO"; }
denied() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).hookSpecificOutput.permissionDecision==="deny"?0:1)}catch{process.exit(1)}})'; }
json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }

expect_guard() { # expect_guard <allow|deny> <name> <command>
  local out
  out="$(hook guard.js "$(guard_event "$3")" 2>/dev/null)"
  if printf '%s' "$out" | denied; then got=deny; else got=allow; fi
  local verb=allows; [ "$1" = deny ] && verb=blocks
  if [ "$got" = "$1" ]; then row PASS "guard $verb: $2"; else row FAIL "guard $verb: $2" "got $got ${out:0:200}"; fi
}

echo "agent-team GitLab live test: $PROJECT (branches *-live-$TS)"

# 1. Clone and set up branches.
glab repo clone "$PROJECT" "$REPO" -- -q >/dev/null 2>&1 || { echo "FAIL: could not clone $PROJECT with glab"; exit 1; }
cd "$REPO"
git config user.email >/dev/null || git config user.email "agent-team-live@example.invalid"
git config user.name >/dev/null || git config user.name "agent-team live test"
if git rev-parse -q --verify HEAD >/dev/null; then git checkout -q -b "$MAIN"; else git checkout -q --orphan "$MAIN"; fi
echo "live $TS" > "live-$TS.txt" && git add "live-$TS.txt" && git commit -q -m "live test base $TS"
git push -q -u origin "$MAIN" 2>/dev/null || { echo "FAIL: push to $PROJECT refused"; exit 1; }
git checkout -q -b "$MS" && git push -q -u origin "$MS"
git checkout -q -b "$TASK" && echo "task" >> "live-$TS.txt" && git commit -q -am "live task $TS" && git push -q -u origin "$TASK"

glab mr create --source-branch "$TASK" --target-branch "$MS" --title "agent-team live $TS task" --description "live test" --yes >/dev/null 2>&1
MR_A="$(glab mr view "$TASK" --output json 2>/dev/null | json_field iid)"
glab mr create --source-branch "$MS" --target-branch "$MAIN" --title "agent-team live $TS milestone" --description "live test" --yes >/dev/null 2>&1
MR_B="$(glab mr view "$MS" --output json 2>/dev/null | json_field iid)"
if [ -n "$MR_A" ] && [ -n "$MR_B" ]; then row PASS "glab mr create ×2" "!$MR_A → $MS, !$MR_B → $MAIN"; else row FAIL "glab mr create ×2" "A='$MR_A' B='$MR_B'"; fi

# 2. The JSON shape the forge layer reads.
VIEW="$(glab mr view "$MR_A" --output json 2>/dev/null)"
for f in iid state target_branch; do
  [ -n "$(printf '%s' "$VIEW" | json_field "$f")" ] && row PASS "mr view json has $f" || row FAIL "mr view json has $f"
done
[ "$(printf '%s' "$VIEW" | json_field target_branch)" = "$MS" ] && row PASS "target_branch is the milestone" || row FAIL "target_branch is the milestone"

# 3. Forge detection and the session-start note.
DETECTED="$(cd "$REPO" && node -e 'console.log(require(process.argv[1]).detect(process.cwd()))' "$PLUGIN/scripts/forge.js")"
if [ "$DETECTED" = gitlab ]; then
  row PASS "forge detected from remote host"
else
  row PASS "forge from remote host: $DETECTED (neutral host name; setting git config agent-team.forge)"
  git config agent-team.forge gitlab
fi
hook session-start.js '{"hook_event_name":"SessionStart"}' | grep -q 'agent-team forge: gitlab' \
  && row PASS "session-start names the forge" || row FAIL "session-start names the forge"

# 4. Guard against real glab answers.
expect_guard allow "merge into milestone" "glab mr merge $MR_A --squash --remove-source-branch --yes"
expect_guard deny  "merge into protected stand-in main" "glab mr merge $MR_B --yes"
expect_guard deny  "accept alias into protected" "glab mr accept $MR_B -y"
expect_guard deny  "merge of an MR that doesn't exist" "glab mr merge 99999999 --yes"
expect_guard deny  "api merge into protected" "glab api -X PUT projects/:id/merge_requests/$MR_B/merge"
expect_guard allow "api merge into milestone" "glab api -X PUT projects/:id/merge_requests/$MR_A/merge"
expect_guard deny  "api unprotect branch" "glab api -X DELETE projects/:id/protected_branches/$MAIN"
expect_guard deny  "push to protected stand-in main" "git push origin $MAIN"

# 5. A real merge into the milestone, then the merge logger.
MERGE_CMD="glab mr merge $MR_A --squash --remove-source-branch --yes"
OUT="$(cd "$REPO" && $MERGE_CMD 2>&1)"; RC=$?
[ $RC -eq 0 ] && row PASS "glab mr merge into milestone" || row FAIL "glab mr merge into milestone" "${OUT:0:200}"
mkdir -p "$REPO/.agent-team/logs"
EVENT="$(node -e 'process.stdout.write(JSON.stringify({hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command:process.argv[1]},tool_response:{stdout:process.argv[2]},cwd:process.argv[3]}))' "$MERGE_CMD" "$OUT" "$REPO")"
hook log-delegation.js "$EVENT" >/dev/null
LINE="$(tail -n 1 "$REPO/.agent-team/logs/merges.jsonl" 2>/dev/null)"
OUTCOME="$(printf '%s' "$LINE" | json_field outcome)"
case "$OUTCOME" in
  merged|auto-merge-queued) row PASS "merge log outcome" "$OUTCOME" ;;
  *) row FAIL "merge log outcome" "${LINE:-no merges.jsonl line}" ;;
esac
[ "$(printf '%s' "$LINE" | json_field outcome_source)" = "glab mr view" ] && row PASS "merge log source is glab mr view" || row FAIL "merge log source is glab mr view"
[ "$(printf '%s' "$LINE" | json_field forge)" = gitlab ] && row PASS "merge log forge field" || row FAIL "merge log forge field"
[ "$(printf '%s' "$LINE" | json_field milestone)" = "live-$TS" ] && row PASS "merge log milestone from target branch" || row FAIL "merge log milestone from target branch" "$LINE"
[ "$OUTCOME" = merged ] && MR_A=""   # merged: nothing to close

echo
printf '%s\n' "${ROWS[@]}"
echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
