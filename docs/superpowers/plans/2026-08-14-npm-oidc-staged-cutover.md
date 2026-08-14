# npm OIDC Staged Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove npm Trusted Publishing without exposing a token to automatic release jobs, then remove the temporary recovery path in a gated follow-up PR.

**Architecture:** PR #3 keeps stable and canary publishing on OIDC and adds a separately gated manual token-recovery job. A stacked follow-up PR removes that job after an OIDC canary succeeds, at which point a release administrator can delete the GitHub secret and revoke the npm token.

**Tech Stack:** GitHub Actions, npm Trusted Publishing, Changesets, Yarn 4, Node.js 24

**Spec:** `NPM_PUBLISHING.md`

## Global Constraints

- Never expose `SHIELDED_NPMJS_TOKEN`, `NPM_TOKEN`, or `NODE_AUTH_TOKEN` to automatic jobs.
- Never merge either PR; a human reviews the evidence and decides whether to merge.
- Keep npm packages restricted until the open-source governance case records a final GO.
- Pin the npm CLI used for publishing so the OIDC behavior is deterministic.

---

## Task 1: Add release-policy regression coverage

- [x] Add `scripts/test-release-policy.mjs` to verify automatic OIDC jobs are token-free and any temporary token reference is isolated to a confirmed manual recovery job.
- [x] Add `test:release-policy` to `package.json` and run it in CI.
- [x] Run the test before the workflow fix and confirm it fails for the missing deterministic npm pin and staged recovery path.

## Task 2: Implement the staged cutover on PR #3

- [x] Add a confirmation-gated `workflow_dispatch` recovery job to `release.yml`.
- [x] Restrict the automatic stable and canary jobs to pushes on `main`.
- [x] Install an exact npm version in every publish-capable job.
- [x] Update publishing documentation with the proof and cleanup sequence.

## Task 3: Verify and update PR #3

- [ ] Run release-policy, workflow, lint, build, typecheck, and test verification.
- [ ] Commit with signing, DCO, and the required assistance trailer; push without force.
- [ ] Update PR #3's description and review context to explain restricted packages, provenance, and the retained recovery path.

## Task 4: Open the cleanup follow-up PR

- [ ] Branch from the updated PR #3 head.
- [ ] Remove the manual token-recovery trigger/job and update documentation for steady state.
- [ ] Re-run verification and commit/push the cleanup.
- [ ] Open a stacked PR labeled `bot:ai-assisted` and `status:do-not-merge`, explicitly gated on successful post-merge OIDC proof from PR #3.
