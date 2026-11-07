import { ProofError } from '../types/errors.js';
import type { ProofServerAttestation } from '../types/network.js';
import type { AttestedChannel, ServerProverConfig } from './attested-channel.js';
import { pinnedRequest, SpkiMismatchError } from './pinned-https.js';

const SESSION_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 300_000;

interface VeriteeSession {
  report: {
    establishedAt: number;
    evidence: {
      attestationJson: {
        webserverTls: {
          endpoints: Record<string, { host: string; spkiSha256: string }>;
        };
      };
    };
  };
  prove(request: { body: Uint8Array }): Promise<{ status: number; body: Uint8Array }>;
  close(): Promise<void>;
}

interface VeriteeModule {
  AMD_ROOT_CERTIFICATES: string[];
  LocalAttestationVerifier: new (
    deps: {
      evidenceProvider: unknown;
      localVerifier: unknown;
      channelBinder: unknown;
    },
    config: { proofServerApiUrl: string; amdRootCertificates: string[]; sessionTtlMs: number },
  ) => { establishLocalSession(pin: ProofServerAttestation['pin']): Promise<VeriteeSession> };
  RawSnpEvidenceProvider: new (options: { host: string }) => unknown;
  RealLocalVerifier: new () => unknown;
  NodeTlsChannelBinder: new () => unknown;
}

const channels = new Map<string, Promise<AttestedChannel>>();

function channelKey(config: ServerProverConfig & { attestation: ProofServerAttestation }): string {
  const pin = config.attestation.pin;
  return [
    config.url,
    config.attestation.attestationHost,
    pin.launchMeasurement,
    pin.imageId,
    String(pin.microcodeSvn),
    String(pin.snpfwSvn),
    pin.pcrs[0],
    pin.pcrs[1],
    pin.pcrs[2],
    pin.pcrs[3],
    pin.pcrs[4],
    pin.applicationDiskRoothash,
  ].join('\n');
}

async function loadVeritee(): Promise<VeriteeModule> {
  // Published on GitHub packages as @input-output-hk/veritee-attestation-verifier@^0.5.0.
  // Resolution needs a token with read:packages; a 403 here is that auth, not a bad pin.
  const specifier = '@input-output-hk/veritee-attestation-verifier';
  try {
    return await (import(specifier) as Promise<VeriteeModule>);
  } catch (cause) {
    throw new ProofError(
      'The remote proof server needs @input-output-hk/veritee-attestation-verifier@^0.5.0. Install it from GitHub packages with a token that has read:packages.',
      cause,
    );
  }
}

function apiSpki(session: VeriteeSession, proofServerApiUrl: string): string {
  let apiHost: string;
  try {
    apiHost = new URL(proofServerApiUrl).hostname;
  } catch {
    throw new ProofError(`Invalid proof server URL "${proofServerApiUrl}"`);
  }
  const endpoints = Object.values(session.report.evidence.attestationJson.webserverTls.endpoints);
  const match = endpoints.find((endpoint) => endpoint.host === apiHost);
  if (!match) {
    const available = endpoints.map((endpoint) => endpoint.host).join(', ');
    throw new ProofError(
      `Attestation for ${proofServerApiUrl} has no TLS pin for host ${apiHost} (available: ${available || 'none'})`,
    );
  }
  return match.spkiSha256;
}

async function responseBody(
  baseUrl: string,
  path: '/check' | '/prove' | '/ready',
  method: 'GET' | 'POST',
  body: Uint8Array | undefined,
  pin: string,
): Promise<Uint8Array> {
  const response = await pinnedRequest(baseUrl, path, method, body, pin, REQUEST_TIMEOUT_MS);
  if (response.status !== 200) {
    throw new ProofError(`Proof server at ${baseUrl} returned HTTP ${response.status} for ${path}`);
  }
  return response.body;
}

/**
 * One local attestation session for this proof server, reused until the
 * process drops it. `/prove` goes through the session, which re-checks the
 * quote after the TTL or a dead channel. `/check` carries the same witness,
 * so it waits for the same session and then posts on a connection pinned to
 * the SPKI the session just bound.
 */
export function openAttestedProofChannel(
  config: ServerProverConfig & { readonly attestation: ProofServerAttestation },
): Promise<AttestedChannel> {
  const key = channelKey(config);
  const cached = channels.get(key);
  if (cached) return cached;
  const opening = openChannel(config).catch((cause: unknown) => {
    channels.delete(key);
    throw cause;
  });
  channels.set(key, opening);
  return opening;
}

async function openChannel(
  config: ServerProverConfig & { readonly attestation: ProofServerAttestation },
): Promise<AttestedChannel> {
  const veritee = await loadVeritee();
  const verifier = new veritee.LocalAttestationVerifier(
    {
      evidenceProvider: new veritee.RawSnpEvidenceProvider({ host: config.attestation.attestationHost }),
      localVerifier: new veritee.RealLocalVerifier(),
      channelBinder: new veritee.NodeTlsChannelBinder(),
    },
    {
      proofServerApiUrl: config.url,
      amdRootCertificates: veritee.AMD_ROOT_CERTIFICATES,
      sessionTtlMs: SESSION_TTL_MS,
    },
  );
  let session = await verifier.establishLocalSession(config.attestation.pin);

  const fresh = async (): Promise<VeriteeSession> => {
    if (Date.now() - session.report.establishedAt > SESSION_TTL_MS) {
      await session.close();
      session = await verifier.establishLocalSession(config.attestation.pin);
    }
    return session;
  };

  const postCheck = async (body: Uint8Array): Promise<Uint8Array> => {
    const current = await fresh();
    const pin = apiSpki(current, config.url);
    try {
      return await responseBody(config.url, '/check', 'POST', body, pin);
    } catch (cause) {
      if (!(cause instanceof SpkiMismatchError)) throw cause;
      await session.close();
      session = await verifier.establishLocalSession(config.attestation.pin);
      return responseBody(config.url, '/check', 'POST', body, apiSpki(session, config.url));
    }
  };

  return {
    check: postCheck,
    async prove(body) {
      const current = await fresh();
      const response = await current.prove({ body });
      if (response.status !== 200) {
        throw new ProofError(`Proof server at ${config.url} returned HTTP ${response.status} for /prove`);
      }
      return response.body;
    },
    async ready() {
      const current = await fresh();
      let response: { status: number; body: Uint8Array };
      try {
        response = await pinnedRequest(
          config.url,
          '/ready',
          'GET',
          undefined,
          apiSpki(current, config.url),
          REQUEST_TIMEOUT_MS,
        );
      } catch (cause) {
        if (!(cause instanceof SpkiMismatchError)) throw cause;
        await session.close();
        session = await verifier.establishLocalSession(config.attestation.pin);
        response = await pinnedRequest(
          config.url,
          '/ready',
          'GET',
          undefined,
          apiSpki(session, config.url),
          REQUEST_TIMEOUT_MS,
        );
      }
      if (response.status === 503) {
        let jobsProcessing = 0;
        let jobsPending = 0;
        try {
          const busy = JSON.parse(new TextDecoder().decode(response.body)) as {
            jobsProcessing?: number;
            jobsPending?: number;
          };
          jobsProcessing = busy.jobsProcessing ?? 0;
          jobsPending = busy.jobsPending ?? 0;
        } catch {
          // The status code is the busy signal. A body that is not JSON still means the server refused the job.
        }
        throw new ProofError(
          `Proof server at ${config.url} is busy (${jobsProcessing} jobs processing, ${jobsPending} pending)`,
        );
      }
      if (response.status !== 200) {
        throw new ProofError(`Proof server at ${config.url} returned HTTP ${response.status} for /ready`);
      }
    },
  };
}
