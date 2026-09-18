# Pre-seed fixtures

Real chain data for the dust-collapse tests in
`tests/unit/sync/dust-reference-collapse.test.ts`. They are recorded rather than
synthesised because the property under test is a ledger one: a collapsed
reference must replay real events to the same roots as the original.

## `preview-519470-dust.dat.gz`

The uncollapsed preview reference's dust snapshot, exactly as the extension
shipped it before collapsing (`packages/extension/public/preseed/preview/dust.dat.gz`
at `918f7e4`), with that bundle's manifest beside it as
`preview-519470-manifest.json`.

| Field | Value |
| --- | --- |
| Height | 519,470 |
| Dust cursor (`offset`) | 141,062 |
| Dust witness | `dustLedgerEvents` id 141,062, digest `c06b5b9d6cb192f2` |
| Serialized state | 131,427 B |
| Generation tree first free | 5,886 |
| Commitment tree first free | 67,922 |

## `preview-dust-events-141065-142216.json.gz`

The 771 `dustLedgerEvents` that follow that cursor (ids 141,065 to 142,216),
recorded from `https://indexer.preview.midnight.network/api/v4/graphql` on
2026-09-15. A gzipped JSON array of `{id, raw}`, where `raw` is the event's hex
as the indexer serves it.

The slice ends at the fifth `dustGenerationDtimeUpdate` whose leaf index falls
inside the collapsed range (below 5,886). Those updates land on leaves the
collapse removed, which is the case the replay test exists to cover. The slice
holds 722 `dustSpendProcessed`, 31 `dustInitialUtxo` and 18
`dustGenerationDtimeUpdate` events.

To re-record, subscribe with `subscription { dustLedgerEvents(id: 141061) { id raw } }`
over `graphql-transport-ws`, keep events with `id > 141062`, and stop at the same
condition. If preview's indexer renumbers, the witness above stops matching and
the slice should be re-cut from a fresh reference instead.
