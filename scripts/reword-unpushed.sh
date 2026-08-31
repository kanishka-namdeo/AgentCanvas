#!/bin/bash
# reword-unpushed.sh — rewrite the 3 unpushed UUID-named commits on main with
# conventional-commit messages WITHOUT detaching HEAD (the sandbox watchdog
# force-checkouts main; cherry-pick/detach flows get hijacked — see reflog).
#
# Method: git commit-tree plumbing — new commit objects with IDENTICAL trees,
# preserved author dates, new messages; then a single `git reset` on main.
# Usage: bash scripts/reword-unpushed.sh
set -euo pipefail
cd /home/z/my-project

# 0. Clean up any dangling cherry-pick state (from the failed attempt).
if [ -f .git/CHERRY_PICK_HEAD ]; then
  git cherry-pick --abort 2>/dev/null || rm -f .git/CHERRY_PICK_HEAD
  echo "cleaned dangling cherry-pick"
fi

# 1. Sanity: no TRACKED modifications (untracked files are fine; docs edits are stashed).
if [ -n "$(git status --porcelain | grep -v '^??')" ]; then
  echo "ABORT: tracked changes present"; git status --porcelain | grep -v '^??'; exit 1
fi

BASE=origin/main
C1=1c6d0f6  # render-ms-canvas + exec bits
C2=26c40e8  # VLM critique artifacts
C3=3103d46  # prompt/resolver defect fixes

# 2. Build the rewritten chain with commit-tree (identical trees).
export GIT_AUTHOR_NAME="Z User"
export GIT_AUTHOR_EMAIL="z@container"
export GIT_COMMITTER_NAME="Z User"
export GIT_COMMITTER_EMAIL="z@container"

GIT_AUTHOR_DATE="2026-08-31T04:03:25+00:00" GIT_COMMITTER_DATE="2026-08-31T04:03:25+00:00" \
N1=$(git commit-tree "$C1^{tree}" -p "$BASE" \
  -m "feat(eval): canvas-only renderer for multishot scenario PNGs + exec-bit normalization" \
  -m "- scripts/render-ms-canvas.ts: renders each multishot scenario's final canvas to PNG (content bbox frame-fit, 24px margin, 2x scale, no app chrome) as VLM-critique input
- normalize 75 tracked artifacts to the exec bit (100644 to 100755)")

GIT_AUTHOR_DATE="2026-08-31T09:18:31+00:00" GIT_COMMITTER_DATE="2026-08-31T09:18:31+00:00" \
N2=$(git commit-tree "$C2^{tree}" -p "$N1" \
  -m "docs(prompt-tuning): deferred VLM critique via kimi-k2-5 fallback — mean 6.17/10, 5/6 claims verified" \
  -m "- scripts/agent-eval/vlm-critique-pt.ts: 6-dim rubric critique runner (provider=kimi|zai|auto, --repeats, defensive JSON parse)
- scripts/vlm-inspect/probe-vlm-quota.ts: vision-quota probe (z.ai 429-blocked; kimi-k2-5 image-capable)
- 3 canvases x 2 repeats: pricing 5.5 / login 6.0 / dashboard 7.0; severity h/m/l = 9/21/16
- deterministic cross-check (pixel sampling + canvas JSON): clipped billing toggle, dark-bar overflow, clipped title, invisible shadows, unrequested content all TRUE; 'near-invisible headline' refuted
- final-report.md sections 2/7/8/9 updated")

GIT_AUTHOR_DATE="2026-08-31T09:51:10+00:00" GIT_COMMITTER_DATE="2026-08-31T09:51:10+00:00" \
N3=$(git commit-tree "$C3^{tree}" -p "$N2" \
  -m "fix(agent): land prompt/resolver fixes for the 5 VLM-verified defect classes (PROMPT_VERSION 2026-08-31.4)" \
  -m "Prompt rules: POSITIONAL FIDELITY (placement words are hard constraints), NO INVENTED CONTENT (enumerated content rendered verbatim, nothing extra), RESOLVER WARNINGS ARE DEFECTS (turn not done while warnings remain), PAGE/ROOT frames must be fit_content, shadow visibility floor, enhanced VERIFY step.

Resolver: new text_overflow (FIXED width vs estimated text, tolerance-banded) + flow_child_absolute_coords (40px intent-vs-reality contradiction in flow children) warnings; container_overflow now reports the worst escape across ALL overflow children.

Tests: resolve-tree.test.ts warning contract; audit-design-budget explicit timeout budget.

Retroactive catch check (scripts/vlm-inspect/probe-resolve-warnings.ts): all 3 historical defect canvases now emit the right warnings.")

echo "new chain: N1=$N1 N2=$N2 N3=$N3"

# 3. Verify trees are identical to the originals (content invariance).
[ "$(git rev-parse "$N1^{tree}")" = "$(git rev-parse "$C1^{tree}")" ] || { echo "ABORT: N1 tree drift"; exit 1; }
[ "$(git rev-parse "$N2^{tree}")" = "$(git rev-parse "$C2^{tree}")" ] || { echo "ABORT: N2 tree drift"; exit 1; }
[ "$(git rev-parse "$N3^{tree}")" = "$(git rev-parse "$C3^{tree}")" ] || { echo "ABORT: N3 tree drift"; exit 1; }
echo "tree invariance verified"

# 4. Move main to the rewritten tip (trees identical -> --hard changes no files).
git reset --hard "$N3"
echo "main now at: $(git log --oneline -1)"

# 5. Show the result.
git log --oneline origin/main..HEAD
