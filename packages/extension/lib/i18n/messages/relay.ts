// Node-relay reachability. Wording avoids "rate limited": the failure we see in
// practice is a flat refusal (HTTP 403 from the endpoint's load balancer), not a
// throughput limit, and naming it as a limit sends people looking for a quota
// that does not exist.
export const relay = {
  relay_unreachableTitle: "Can't reach the node",
  /** Shown to everyone. Says what is lost, not what went wrong: sync is driven
   *  by the indexer and keeps working, so balances stay correct and only
   *  sending is affected. */
  relay_unreachableBody: 'Balances are up to date, but sending is unavailable until the connection returns.',
  relay_forbiddenTitle: 'The node refused the connection',
  relay_forbiddenBody: 'This endpoint is rejecting this wallet. Sending is unavailable; balances are unaffected.',
  relay_retry: 'Retry now',
  relay_retrying: 'Retrying…',
  /** Developer mode: $1 = HTTP status, e.g. "403". */
  relay_detailStatus: 'HTTP $1',
  relay_detailNoStatus: 'No response',
  /** $1 = attempt count. */
  relay_detailAttempts: '$1 attempts',
  relay_detailAttemptsOne: '1 attempt',
  /** $1 = seconds until the next attempt reaches the wire. */
  relay_detailNextRetry: 'next retry in $1s',
  relay_detailNextRetryNow: 'retrying now',
} as const;
