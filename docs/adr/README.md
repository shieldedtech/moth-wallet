# Architecture Decision Records

This directory holds **Architecture Decision Records** (ADRs) for the project — short documents capturing significant technical choices and the reasoning behind them. Future contributors read these to understand *why* the code looks the way it does, without having to recover the context from chat logs or commit messages.

The format is loosely [MADR](https://adr.github.io/madr/) with a Validation section added — Shielded Technologies projects state, up front, how we'll know whether a decision worked.

## When to write an ADR

Write one when the decision:

- Is hard to reverse (database schema, public API, wire protocol, key derivation scheme).
- Affects more than one team or service.
- Picks between two or more credible options that a reasonable engineer might disagree on.
- Introduces a new dependency, language, or runtime.
- Touches cryptography, consensus, privacy boundaries, or security policy.

Don't write one for:

- Style choices already settled by tooling (formatter rules, lint config).
- Routine library upgrades.
- Bug fixes that don't change architecture.

Rule of thumb: if you'd want to read this document in six months when something breaks, write it.

## Process

1. **Copy** `0000-template.md` to `NNNN-short-kebab-title.md`, using the next available number.
2. **Open a PR** with status `Proposed` and request review from at least one CODEOWNER for the affected area.
3. **Discuss in the PR.** ADRs are reviewed like code — request changes, comment, iterate.
4. **Set status to `Accepted`** when the PR is approved and merged. The merge is the decision.
5. **If later superseded**, do NOT delete the old ADR. Set its status to `Superseded by [ADR-NNNN](NNNN-title.md)` and link forward. Decisions stay in the historical record.

## Numbering

- Four-digit zero-padded, sequential: `0001`, `0002`, …, `0042`.
- Pick the next number when you open the PR. If two PRs collide, the second one rebases and renumbers — better to fix it once than to leave gaps or duplicates.

## Status lifecycle

```text
Proposed ──► Accepted ──► Deprecated
    │            │
    │            └──► Superseded by ADR-NNNN
    │
    └──► Rejected
```

A `Rejected` ADR is still valuable — it documents *why* we said no.

## Index

| #    | Title                                                      | Status   | Date       |
| ---- | ---------------------------------------------------------- | -------- | ---------- |
| 0000 | [Template](0000-template.md)                               | n/a      | —          |

Add a row to this table when you accept an ADR. Keep entries chronological.
