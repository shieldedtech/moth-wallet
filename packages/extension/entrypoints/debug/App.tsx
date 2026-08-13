// Phase timings viewer. A standalone page rather than a Settings row on purpose:
// the panel shows GetStarted until a wallet exists (App.tsx), so nothing behind
// Settings can be reached before the first wallet — and wallet creation and the
// pre-seed reference build are exactly the phases worth measuring then. This page
// is reachable at chrome-extension://<id>/debug.html in any state.
//
// Not localised: a developer instrument, exempted in the no-hardcoded-strings
// guard (EXCLUDED_DIRS) rather than translated — its labels are metric names, and
// putting those in the shipped catalogs would cost three translations per rename.

import { useCallback, useEffect, useState } from 'react';
import { sendMessage } from '../../lib/messaging/protocol';
import type { TimingEntry } from '../../lib/background/timings';
import { asCurl, type MeterSnapshot } from '../../lib/offscreen/request-meter';
import { Button } from '../../components/ui/button';

const REFRESH_MS = 2000;

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtClock(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

export function App() {
  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<TimingEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [requests, setRequests] = useState<MeterSnapshot | null>(null);
  const [curlCopied, setCurlCopied] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await sendMessage('debugTimings', undefined);
      setEnabled(state.enabled);
      setEntries(state.entries);
      // Counted unconditionally in the worker, so this needs no enabling — it
      // is already true by the time anyone opens this page to look.
      setRequests(await sendMessage('debugRequestStats', undefined));
    } catch {
      /* service worker asleep; the next tick retries */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await sendMessage('debugTimingsSetEnabled', { enabled: next });
    await refresh();
  };

  const clear = async () => {
    await sendMessage('debugTimingsClear', undefined);
    await refresh();
  };

  // Shaped to be diffable against scripts/sync-benchmark.mjs output.
  //
  // Failures are deliberately dropped here. Everything else on this page is
  // counts and timings, safe to hand to anyone; a captured failure carries the
  // request body the wallet actually sent. Keeping it out of the one-click
  // export means "Copy JSON" stays something you can use without reading it
  // first — the failures below have their own copy, with its own warning.
  const asJson = () => {
    const counts = requests ? { ...requests, failures: undefined } : null;
    return JSON.stringify({ capturedAt: new Date().toISOString(), requests: counts, entries }, null, 2);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(asJson());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const copyCurl = async (index: number) => {
    const failure = requests?.failures[index];
    if (!failure) return;
    await navigator.clipboard.writeText(asCurl(failure));
    setCurlCopied(index);
    setTimeout(() => setCurlCopied(null), 1500);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([asJson()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `moth-timings-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // The slowest phases are what this page exists to surface.
  const slowest = [...entries].sort((a, b) => b.deltaMs - a.deltaMs).slice(0, 3);
  const slowestAt = new Set(slowest.map((e) => e.at));

  return (
    <div className="mx-auto max-w-[900px] p-6 font-sans">
      <h1 className="m-0 font-display text-2xl font-extrabold">Phase timings</h1>
      <p className="mb-5 mt-1 text-[13px] text-muted-foreground">
        Records how long each wallet phase takes — unlock, sync, transactions, reference builds.
        Labels, durations and sizes only: no addresses, amounts or wallet names.
      </p>

      {/* Request volume. Above the timings controls because when someone opens
          this page after a 403, this is the thing they came for. Always on — no
          toggle — since a rate you have to remember to enable is one you do not
          have when the problem happens. */}
      {requests && requests.hosts.length > 0 && (
        <div className="mb-5 rounded-[16px] bg-card p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="m-0 font-display text-base font-bold">Requests</h2>
            <span className="text-[12.5px] text-muted-foreground">
              {requests.totalInWindow} in the last 5 min · meter up {fmtMs(requests.uptimeMs)}
            </span>
          </div>
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Host</th>
                <th className="py-1 pr-3 font-medium">Total</th>
                <th className="py-1 pr-3 font-medium">5 min</th>
                <th className="py-1 pr-3 font-medium">/s now</th>
                <th className="py-1 pr-3 font-medium">/s avg</th>
                <th className="py-1 pr-3 font-medium">/s peak</th>
                <th className="py-1 font-medium">Outcomes</th>
              </tr>
            </thead>
            <tbody>
              {requests.hosts.map((h) => (
                <tr key={h.host} className="border-t border-muted">
                  <td className="py-1.5 pr-3 font-mono">{h.host}</td>
                  <td className="py-1.5 pr-3 tabular-nums font-semibold">{h.totalAllTime}</td>
                  {/* Zero here on a quiet wallet is normal, and is itself the
                      answer: the rates beside it are not the story. */}
                  <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{h.total}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{h.perSecond}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{h.perSecondAvg60}</td>
                  {/* The number a rate limiter trips on. Shown with its time so
                      a burst can be lined up against whatever caused it. */}
                  <td className="py-1.5 pr-3 tabular-nums">
                    <span className={h.peakPerSecond >= 10 ? 'font-semibold text-destructive' : ''}>
                      {h.peakPerSecond}
                    </span>
                    {h.peakAt !== null && h.peakPerSecond > 1 && (
                      <span className="ml-1 text-muted-foreground">at {fmtClock(h.peakAt)}</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    {/* 403 called out by name: it is the reason this exists, and
                        burying it in a 4xx bucket would hide the answer. */}
                    {h.byStatus.forbidden > 0 && (
                      <span className="mr-2 font-semibold text-destructive">{h.byStatus.forbidden} × 403</span>
                    )}
                    {h.byStatus.failed > 0 && (
                      <span className="mr-2 text-destructive">{h.byStatus.failed} failed</span>
                    )}
                    {h.byStatus.serverError > 0 && <span className="mr-2">{h.byStatus.serverError} × 5xx</span>}
                    {h.byStatus.otherClientError > 0 && <span className="mr-2">{h.byStatus.otherClientError} × 4xx</span>}
                    <span className="text-muted-foreground">{h.byStatus.ok} ok</span>
                    {/* Says how old everything on this row is. Without it, a
                        retained 403 from an hour ago reads as one happening now. */}
                    {h.sinceLastMs !== null && h.sinceLastMs > 60_000 && (
                      <span className="ml-2 text-muted-foreground">· quiet for {fmtMs(h.sinceLastMs)}</span>
                    )}
                    {/* Sockets have no HTTP status, so without this a relay
                        reconnect storm shows as requests with no outcome. */}
                    {(h.sockets.opened > 0 || h.sockets.neverOpened > 0) && (
                      <span className="ml-2 text-muted-foreground">
                        · ws {h.sockets.opened} open
                        {h.sockets.neverOpened > 0 && (
                          <span className="font-semibold text-destructive"> · {h.sockets.neverOpened} refused</span>
                        )}
                        {Object.keys(h.sockets.closeCodes).length > 0 && (
                          <span>
                            {' '}
                            (
                            {Object.entries(h.sockets.closeCodes)
                              .map(([code, n]) => `${n}×${code}`)
                              .join(', ')}
                            )
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="m-0 mt-2 text-[12px] text-muted-foreground">
            Counted when a request is sent, which is what a rate limiter sees. Totals, outcomes and the
            peak are kept for as long as the wallet has been running; only the rates are windowed, so a
            quiet host still reports what happened to it earlier. This table is hosts and counts only —
            no request bodies, URLs or headers.
          </p>
        </div>
      )}

      {/* Counts tell you that a request was refused. They do not tell you whether
          the wallet or the network is at fault — for that you have to send the
          same request yourself, from outside the extension. Hence the last few
          failures, verbatim, and a curl that replays one. */}
      {requests && requests.failures.length > 0 && (
        <div className="mb-5 rounded-[16px] border border-destructive/30 bg-card p-4">
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="m-0 font-display text-base font-bold">Last {requests.failures.length} failures</h2>
            <span className="text-[12.5px] text-muted-foreground">newest first</span>
          </div>
          <p className="m-0 mb-3 text-[12px] font-semibold text-destructive">
            Unlike the rest of this page, this includes real request bodies and headers. Read it before
            pasting it anywhere public.
          </p>
          <ul className="m-0 list-none space-y-2 p-0">
            {requests.failures.map((f, i) => (
              <li key={`${f.at}-${i}`} className="border-t border-muted pt-2 text-[12.5px]">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="font-semibold text-destructive">
                      {f.status === null ? f.statusText || 'no response' : f.status}
                    </span>
                    <span className="ml-2 font-mono">{f.method}</span>
                    {/* Wraps rather than truncates: a query string is often the
                        difference between two requests that failed differently. */}
                    <span className="ml-2 break-all font-mono text-muted-foreground">{f.url}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtClock(f.at)}</span>
                </div>
                {f.responseBody && (
                  <pre className="m-0 mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[11.5px] text-muted-foreground">
                    {f.responseBody}
                  </pre>
                )}
                <Button
                  variant="outline"
                  className="mt-1.5 h-7 px-2 text-[12px]"
                  onClick={() => void copyCurl(i)}
                >
                  {curlCopied === i ? 'Copied' : 'Copy as curl'}
                </Button>
              </li>
            ))}
          </ul>
          {/* The header the wallet never sees: declarativeNetRequest adds it after
              JS hands the request off, so a faithful replay has to supply it. */}
          <p className="m-0 mt-3 text-[12px] text-muted-foreground">
            The curl references <code className="font-mono">$MOTH_NODE_AUTH</code> where the node auth
            header would go — export it first if your endpoint needs one, or drop the header to see how
            the endpoint answers without it.
          </p>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button onClick={() => void toggle()} variant={enabled ? 'outline' : 'default'}>
          {enabled ? 'Stop recording' : 'Start recording'}
        </Button>
        <Button variant="outline" onClick={() => void copy()} disabled={entries.length === 0}>
          {copied ? 'Copied' : 'Copy JSON'}
        </Button>
        <Button variant="outline" onClick={download} disabled={entries.length === 0}>
          Download
        </Button>
        <Button variant="ghost" className="text-destructive" onClick={() => void clear()} disabled={entries.length === 0}>
          Clear
        </Button>
        <span className="ml-auto text-[12.5px] text-muted-foreground">
          {enabled ? 'recording' : 'idle'} · {entries.length} entries
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {enabled
            ? 'Recording. Unlock the wallet, create an account, or start a reference build, then come back.'
            : 'Nothing recorded yet. Start recording, then exercise the phase you want to measure.'}
        </p>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Time</th>
              <th className="py-2 pr-3 font-medium">Δ</th>
              <th className="py-2 pr-3 font-medium">Source</th>
              <th className="py-2 font-medium">Phase</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.at}-${i}`} className="border-b border-border/50 align-top">
                <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted-foreground">{fmtClock(e.at)}</td>
                <td
                  className={`whitespace-nowrap py-1.5 pr-3 tabular-nums font-semibold ${
                    slowestAt.has(e.at) ? 'text-destructive' : ''
                  }`}
                >
                  {fmtMs(e.deltaMs)}
                </td>
                <td className="py-1.5 pr-3 text-muted-foreground">{e.source}</td>
                <td className="py-1.5">
                  {e.label}
                  {e.detail && (
                    <span className="ml-2 text-muted-foreground">
                      {Object.entries(e.detail)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' ')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
