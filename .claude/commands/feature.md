---
description: Turn this session into a PM-OS feature session — worktree build, in-place review loop (Daniel cds to the worktree), merge to development
argument-hint: <feature-name>
---

This session is now a **feature session** for `feature/$ARGUMENTS`. Follow this flow exactly.

**One /feature per conversation.** If this session is already a feature session (this command was invoked earlier in the conversation), do NOT start the flow again — that's an unhandled case (two worktrees, ambiguous session contract). Stop and discuss with Daniel what he intends (switch feature? resume? mistake?) before doing anything.

## Session contract

- From this point on: **ZERO file changes in Daniel's main checkout**. Every edit, build, test run, and dev server happens inside this feature's worktree only. The single exception is creating the worktree itself under `.claude/worktrees/`.
- Commits are authored by Claude (`--author="Claude <noreply@anthropic.com>"`), never Daniel.
- Never leave a dev server running when handing off.

## 1. Setup (once per feature — one worktree per feature)

1. Check `git worktree list` first. If `.claude/worktrees/$ARGUMENTS` already exists (resumed feature), reuse it: `git switch feature/$ARGUMENTS` inside it if detached, and continue from wherever the feature left off. Do NOT recreate it.
2. Otherwise: `git fetch origin`, then `git worktree add .claude/worktrees/$ARGUMENTS -b feature/$ARGUMENTS origin/development`
   (if only the branch already exists, add the worktree on the existing branch instead)
3. Inside the new worktree: `cp -Rc` node_modules from the main checkout, copy `dev-apphosting.yaml`, then run `npx prisma generate` (the cloned client carries a stale schema otherwise).
4. If this feature touches `schema.prisma`: flag it to Daniel — at most one schema-touching feature in flight, since all worktrees share one dev DB via `prisma db push`.

## 2. Build

Build the feature in the worktree. Normal quality bar; follow CLAUDE.md.

## 3. Sync with development — always before review

1. Pull dev into the feature branch: `git fetch origin && git merge origin/development`. Fix conflicts. **If conflicts are severe, stop and consult Daniel before resolving.**
2. Discuss with Daniel whether a short sanity test run on the feature branch is worth it (to make sure development won't break). Small feature → usually skip; decide together.

## 4. Release for review (repeat until approved)

1. Commit your work in the worktree. No push, no detach — Daniel reviews in the worktree itself.
2. Tell Daniel it's ready. **Every "finished" / "ready for review" message — after the initial build and after every review-fix round — must include the worktree's absolute path**, so he can `cd` to it. **Never remove the worktree.**
3. On review comments: fix in the same worktree, commit, notify with the path again. Repeat.

## 5. Tests — discuss first (after approval)

Once Daniel approves the feature, discuss with him: what tests (if any) this feature needs. Only implement what's agreed, in the worktree. Run them, commit the result.

## 6. Merge & clean up

If development moved while the review loop ran, repeat the Sync step first (merge `origin/development` again). Then:

1. Merge `feature/$ARGUMENTS` into `development` and push (this triggers the Playwright CI).
2. Delete the feature branch (local + remote).
3. `git worktree remove` this feature's worktree.
