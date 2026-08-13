// A copyable environment summary for bug reports.
//
// The issue templates ask for "Version / commit" and "Environment", and until
// now a reporter had to work both out by hand — so reports arrived without them
// and the first reply was always a request for more detail.
//
// What this deliberately does NOT include is the more important half. A user
// pasting this into a public issue must not be pasting their identity or their
// credentials, and they will not audit it first — they will trust that a button
// labelled "copy diagnostics" is safe to use in public. So:
//
//   - no addresses, of any sub-wallet
//   - no wallet or account names
//   - no balances, of NIGHT, DUST or any token
//   - no mnemonic or key material, obviously
//   - no node auth header VALUE — it is a shared secret; only whether one is set
//   - any userinfo in a URL is redacted, since `https://user:pass@host` is a
//     credential wearing a URL's clothes
//
// Configuration IS included, because that is what makes a report actionable:
// which network, whether endpoints are overridden and to what, which prover,
// whether developer mode and pre-seed warming are on.
//
// Pure and dependency-free: the redaction rules are the part worth testing, and
// they should be testable without a browser, a wallet or a clipboard.

export interface DiagnosticsInput {
  /** Extension version, from the manifest — never hardcoded. */
  version: string;
  /** `navigator.userAgent`; parsed for browser and OS rather than dumped raw. */
  userAgent: string;
  network: string;
  /** True when the network's endpoints are overridden rather than preset. */
  usesCustomEndpoints: boolean;
  nodeUrl: string;
  indexerUrl: string;
  proverType: 'wasm' | 'server';
  proverUrl?: string;
  /** Whether a node auth header is configured. The value is never reported. */
  hasNodeAuthHeader: boolean;
  /** Whether a name resolver is configured. The URL is reported; it is a
   *  service endpoint, not a personal identifier. */
  nameResolverUrl: string | null;
  autoLockMinutes: number | null;
  preseedWarming: boolean;
  developerMode: boolean;
  /** Pre-seed reference state for the current network, if known. */
  preseed?: { ready: boolean; height: number | null; bundled: boolean };
}

/**
 * Strip credentials from a URL, and leave anything unparseable alone rather
 * than guessing at it.
 *
 * `https://alice:hunter2@indexer.example` is a password, and a reporter pasting
 * it into a public issue has leaked it. Hosts and paths are kept: they are what
 * make the report useful.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return `${parsed.toString()} (credentials removed)`;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Browser and OS from a user-agent string, best-effort. Returns the raw string
 *  when nothing matches, since an unrecognised browser is itself worth seeing. */
export function describeEnvironment(userAgent: string): { browser: string; os: string } {
  const browser =
    /Edg\/([\d.]+)/.exec(userAgent)?.[0].replace('Edg/', 'Edge ') ??
    /OPR\/([\d.]+)/.exec(userAgent)?.[0].replace('OPR/', 'Opera ') ??
    /Firefox\/([\d.]+)/.exec(userAgent)?.[0].replace('/', ' ') ??
    /Chrome\/([\d.]+)/.exec(userAgent)?.[0].replace('/', ' ') ??
    /Version\/([\d.]+).*Safari/.exec(userAgent)?.[1].replace(/^/, 'Safari ') ??
    'unknown';

  const os = /Windows NT ([\d.]+)/.test(userAgent)
    ? `Windows ${/Windows NT ([\d.]+)/.exec(userAgent)![1]}`
    : /Mac OS X ([\d_.]+)/.test(userAgent)
      ? `macOS ${/Mac OS X ([\d_.]+)/.exec(userAgent)![1]!.replace(/_/g, '.')}`
      : /Android ([\d.]+)/.test(userAgent)
        ? `Android ${/Android ([\d.]+)/.exec(userAgent)![1]}`
        : /Linux/.test(userAgent)
          ? 'Linux'
          : 'unknown';

  return { browser, os };
}

/** A markdown block ready to paste into an issue. */
export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const { browser, os } = describeEnvironment(input.userAgent);
  const lines: string[] = [
    '### Environment',
    '',
    `- Wallet: ${input.version}`,
    `- Browser: ${browser}`,
    `- OS: ${os}`,
    '',
    '### Configuration',
    '',
    `- Network: ${input.network}`,
    `- Endpoints: ${input.usesCustomEndpoints ? 'custom' : 'preset'}`,
    `- Node: ${redactUrl(input.nodeUrl)}`,
    `- Indexer: ${redactUrl(input.indexerUrl)}`,
    `- Prover: ${input.proverType}${input.proverUrl ? ` — ${redactUrl(input.proverUrl)}` : ''}`,
    `- Node auth header: ${input.hasNodeAuthHeader ? 'set (value not reported)' : 'not set'}`,
    `- Name resolver: ${input.nameResolverUrl ? redactUrl(input.nameResolverUrl) : 'not set'}`,
    `- Auto-lock: ${input.autoLockMinutes === null ? 'never (demo mode)' : `${input.autoLockMinutes} min`}`,
    `- Developer mode: ${input.developerMode ? 'on' : 'off'}`,
    `- Prepare new accounts: ${input.preseedWarming ? 'on' : 'off'}`,
  ];

  if (input.preseed) {
    const { ready, height, bundled } = input.preseed;
    lines.push(
      `- Pre-seed reference: ${ready ? `ready at height ${height}` : 'none'}${bundled ? ' (ships with this release)' : ''}`,
    );
  }

  lines.push(
    '',
    '_No addresses, account names or balances are included._',
  );
  return lines.join('\n');
}
