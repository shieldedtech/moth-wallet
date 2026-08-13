import { describe, it, expect } from 'vitest';
import {
  buildDiagnosticsReport,
  describeEnvironment,
  redactUrl,
  type DiagnosticsInput,
} from '../lib/ui/diagnostics-report';

const base: DiagnosticsInput = {
  version: '0.11.0',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  network: 'preprod',
  usesCustomEndpoints: false,
  nodeUrl: 'https://rpc.preprod.midnight.network',
  indexerUrl: 'https://indexer.preprod.midnight.network/api/v1/graphql',
  proverType: 'server',
  proverUrl: 'http://localhost:6300',
  hasNodeAuthHeader: false,
  nameResolverUrl: null,
  autoLockMinutes: 15,
  preseedWarming: false,
  developerMode: false,
};

// The whole point of this report is that a user pastes it into a PUBLIC issue
// without auditing it first. These are the things that must never be in it.
describe('what the report must never contain', () => {
  it('never reports the node auth header value, only that one is set', () => {
    const report = buildDiagnosticsReport({ ...base, hasNodeAuthHeader: true });
    expect(report).toContain('set (value not reported)');
    // The value is not an input at all — this pins the shape so nobody adds it.
    expect(Object.keys(base)).not.toContain('nodeAuthHeader');
  });

  it('strips credentials embedded in a URL', () => {
    const report = buildDiagnosticsReport({
      ...base,
      indexerUrl: 'https://alice:hunter2@indexer.example/graphql',
    });
    expect(report).not.toContain('hunter2');
    expect(report).not.toContain('alice');
    expect(report).toContain('credentials removed');
    expect(report).toContain('indexer.example');
  });

  it('has no field for addresses, names or balances', () => {
    // Structural: the input type cannot carry them, so a future edit to the
    // renderer cannot leak them by accident.
    // Matched against whole field names, not substrings: `preseedWarming`
    // legitimately contains "seed" and a substring check flagged it.
    const forbidden = /address|mnemonic|^seed|balance|walletname|accountname/i;
    expect(Object.keys(base).filter((k) => forbidden.test(k))).toEqual([]);
  });

  it('says so in the output, so a reader can trust it at a glance', () => {
    expect(buildDiagnosticsReport(base)).toContain('No addresses, account names or balances');
  });
});

describe('redactUrl', () => {
  it('leaves a clean URL intact', () => {
    expect(redactUrl('https://indexer.example/graphql')).toBe('https://indexer.example/graphql');
  });

  it('leaves an unparseable value alone rather than guessing', () => {
    // Better to show something odd than to mangle it into something misleading.
    expect(redactUrl('not a url')).toBe('not a url');
  });

  it('removes a password even when there is no username', () => {
    expect(redactUrl('https://:secret@host.example')).not.toContain('secret');
  });
});

describe('describeEnvironment', () => {
  it('identifies Chrome on macOS', () => {
    expect(describeEnvironment(base.userAgent)).toEqual({ browser: 'Chrome 141.0.0.0', os: 'macOS 10.15.7' });
  });

  it('identifies Firefox on Windows', () => {
    expect(
      describeEnvironment('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'),
    ).toEqual({ browser: 'Firefox 129.0', os: 'Windows 10.0' });
  });

  it('prefers Edge over the Chrome token it also carries', () => {
    // Edge's UA contains "Chrome/..." too; reporting it as Chrome would send
    // someone chasing the wrong engine.
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
    expect(describeEnvironment(ua).browser).toBe('Edge 141.0.0.0');
  });

  it('says unknown rather than guessing', () => {
    expect(describeEnvironment('some private browser/1.0')).toEqual({ browser: 'unknown', os: 'unknown' });
  });
});

describe('what the report does contain', () => {
  it('carries the configuration that makes a report actionable', () => {
    const report = buildDiagnosticsReport({
      ...base,
      usesCustomEndpoints: true,
      developerMode: true,
      autoLockMinutes: null,
      preseed: { ready: true, height: 2_064_324, bundled: true },
    });
    expect(report).toContain('Wallet: 0.11.0');
    expect(report).toContain('Network: preprod');
    expect(report).toContain('Endpoints: custom');
    expect(report).toContain('Developer mode: on');
    expect(report).toContain('never (demo mode)');
    expect(report).toContain('ready at height 2064324');
    expect(report).toContain('ships with this release');
  });
});
