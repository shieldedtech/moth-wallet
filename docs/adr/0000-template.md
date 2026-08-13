# ADR-0000: <decision title — one short noun phrase>

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Deprecated | Superseded by [ADR-NNNN](NNNN-title.md) -->
- **Date:** YYYY-MM-DD
- **Authors:** @<github-handle>
- **Reviewers:** @<github-handle>, @<github-handle>
- **Tags:** <area, e.g. "consensus, ledger, privacy">

## Context

What's the situation that forced this decision? Include:

- The problem in one or two sentences.
- Constraints that narrow the solution space (performance budgets, compatibility, regulatory, deadline, team skill).
- What is currently in place, if anything, and why it's no longer adequate.

Avoid restating the decision here. The reader should be able to read this section, predict 2–3 candidate solutions, and *then* see what we chose.

## Decision

What we will do. State it as a directive in the present tense:

> We will use X to do Y.

Be specific. Name the component, the library, the protocol, the parameter. Vague decisions ("improve performance") rot fastest.

If the decision has scope limits, name them: "This applies to service A and B; service C continues to use the legacy approach until <date or condition>."

## Alternatives considered

For each option that was on the table, including the one we picked:

### Option A — <name>

- **Summary:** one paragraph.
- **Pros:** bullet list.
- **Cons:** bullet list.
- **Why chosen / not chosen:** one sentence.

### Option B — <name>
...

Listing alternatives is the point of the document. A reader six months from now needs to know "did we consider X?" without re-doing the analysis.

## Consequences

What changes as a result. Split into three buckets:

### Positive

- Concrete benefit. Avoid generic claims like "improved scalability" — say "reduces p99 latency from 200ms to <50ms" or "removes the GIL-bound worker pool."

### Negative

- What we accept by choosing this. Operational cost, lock-in, learning curve, performance trade-off. Be honest — an ADR with no negatives is suspicious.

### Neutral / follow-up

- Things that need to happen because of this decision: migrations, deprecations, doc updates, training, dependency upgrades. Track these as issues and link them.

## Validation

How do we know this decision worked? State the falsifiable conditions:

- **Success criteria:** measurable outcomes we expect within <timeframe>. E.g. "p99 deploy time < 90s by Q3", "zero unverified commits to main for 30 days".
- **Failure signals:** what would make us revisit. E.g. "more than 3 contributors report inability to sign commits", "throughput drops below baseline".
- **Review date:** YYYY-MM-DD or "after <milestone>" — when we revisit this ADR.

## References

- Related ADRs: [ADR-NNNN](NNNN-title.md)
- Issues: #NNN
- External: RFC, spec, paper, vendor doc.
- Prior discussion: PR link, design doc, meeting notes.
