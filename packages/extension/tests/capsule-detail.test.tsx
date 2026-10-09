import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CapsuleView } from '@shieldedtech/capsule-core';
import { CapsuleDetail } from '../components/screens/CapsuleDetail';

const BALLOT = '3a40dae49620d0214eee18574de8b9b44772cb602ace3093d13339da171a3ae4';
const REGISTRY = 'c04d6a072f01b8d8d736c0a31ca32a59b3061fe8dfa2607002533435fa7b70aa';
const block = { height: 12320, hash: 'ab', protocolVersion: 17_000_000, timestamp: Date.UTC(2026, 9, 9, 19, 18, 24) };

const view: CapsuleView = {
  address: BALLOT,
  bundle: 'Ballot',
  fingerprint: '9a7bd2c1e1f0a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5',
  folded: 2,
  fields: { credits: '0', myCommitment: { is_some: true, value: '1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd' } },
  ledger: { nullifiers: ['aa11', 'bb22'], votesFor: '2', votesAgainst: '0' },
  block,
  abi: {
    circuitSignatures: {
      signup: { pure: false, provable: true, argumentTypes: [{ tag: 'Uint', maxval: '18446744073709551615' }], resultType: { tag: 'Tuple', types: [] } },
      vote: { pure: false, provable: true, argumentTypes: [{ tag: 'Boolean' }], resultType: { tag: 'Tuple', types: [] } },
    },
    constructorSignature: { argumentTypes: [{ tag: 'Contract', name: 'VoterRegistry', circuits: {} }] },
    ledgerSignatures: {
      fields: {
        nullifiers: { storage: 'Set', type: { tag: 'Bytes', length: 32 } },
        votesFor: { storage: 'Counter' },
        votesAgainst: { storage: 'Counter' },
      },
    },
    localStateSignatures: {
      fields: {
        credits: { storage: 'Cell', type: { tag: 'Uint', maxval: '15' } },
        myCommitment: {
          storage: 'Cell',
          type: {
            tag: 'Struct',
            name: 'Maybe',
            elements: [
              { name: 'is_some', type: { tag: 'Boolean' } },
              { name: 'value', type: { tag: 'Bytes', length: 32 } },
            ],
          },
        },
      },
      functions: {},
    },
    hostInterfaceSignatures: {
      'midnight:capsule/keys@1.0.0': { secretKey: { argumentTypes: [], resultType: { tag: 'Bytes', length: 32 } } },
    },
  },
  history: [
    {
      transaction: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      circuit: 'signup',
      arguments: ['1760038644'],
      submittedAt: '2026-10-09T14:48:40.000Z',
      block: { ...block, height: 11800 },
      status: 'success',
      result: 'folded',
    },
    {
      transaction: '1f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f1',
      circuit: 'vote',
      arguments: [true],
      submittedAt: '2026-10-09T18:20:25.000Z',
      block: { ...block, height: 12001 },
      status: 'failure',
      result: 'nothing',
    },
  ],
  inFlight: [
    {
      transaction: '2f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f2',
      circuit: 'enroll',
      within: { address: REGISTRY, circuit: 'signup' },
      submittedAt: '2026-10-09T19:18:41.000Z',
      ttl: '2026-10-09T19:28:41.000Z',
    },
  ],
};

describe('CapsuleDetail', () => {
  it('shows the contract, both states with their declared storage, the interface and every call', () => {
    const html = renderToStaticMarkup(<CapsuleDetail capsule={view} onBack={() => {}} />);
    expect(html).toContain('Ballot capsule');
    expect(html).toContain(BALLOT);
    expect(html).toContain('2 transaction(s) folded in');
    expect(html).toContain('as of block 12320');
    expect(html).toContain('Cell&lt;Uint&lt;4&gt;&gt;');
    expect(html).toContain('Cell&lt;Maybe&gt;');
    // Each value in the panel's idiom: a Maybe as the value it holds, bytes truncated with a copy button, a set counted.
    expect(html).toContain('1234abcd12…34abcd');
    expect(html).toContain('aria-label="Copy"');
    expect(html).not.toContain('is_some');
    expect(html).toContain('Set&lt;Bytes&lt;32&gt;&gt;');
    expect(html).toContain('2 item(s)');
    expect(html).toContain('Counter');
    expect(html).toContain('Held only by this wallet.');
  });

  it('renders the interface in the language’s notation and the calls newest first', () => {
    const html = renderToStaticMarkup(<CapsuleDetail capsule={view} onBack={() => {}} />);
    expect(html).toContain('signup(Uint&lt;64&gt;): []');
    expect(html).toContain('vote(Boolean): []');
    expect(html).toContain('circuit · proved');
    expect(html).toContain('host midnight:capsule/keys@1.0.0');
    expect(html).toContain('secretKey(): Bytes&lt;32&gt;');
    expect(html).toContain('constructor(VoterRegistry): []');
    // In flight first, then the history newest first; a callee's call names the asked call it ran inside.
    const enroll = html.indexOf('enroll · inside signup on c04d6a072f…7b70aa');
    const vote = html.indexOf('vote(true)');
    const signup = html.indexOf('signup(&quot;1760038644&quot;)');
    expect(enroll).toBeGreaterThan(-1);
    expect(vote).toBeGreaterThan(enroll);
    expect(signup).toBeGreaterThan(vote);
    expect(html).toContain('in flight · valid until');
    expect(html).toContain('success in block 11800 · folded');
    expect(html).toContain('failure in block 12001 · nothing');
  });

  it('says so when no call has settled yet', () => {
    const html = renderToStaticMarkup(<CapsuleDetail capsule={{ ...view, folded: 0, history: [], inFlight: [] }} onBack={() => {}} />);
    expect(html).toContain('No call on this contract has settled since the capsule came to be.');
    expect(html).not.toContain('before this wallet kept a history');
  });

  it('counts the records folded before the wallet kept a history', () => {
    // Two folded in, one of them in the history: the other predates it.
    const html = renderToStaticMarkup(<CapsuleDetail capsule={{ ...view, inFlight: [] }} onBack={() => {}} />);
    expect(html).toContain('1 transaction(s) folded in before this wallet kept a history');
    const older = renderToStaticMarkup(<CapsuleDetail capsule={{ ...view, history: [], inFlight: [] }} onBack={() => {}} />);
    expect(older).toContain('2 transaction(s) folded in before this wallet kept a history');
    expect(older).toContain('No call has settled since.');
  });

  it('shows a Maybe holding nothing as none, a flag as a pill, and a map as its entries', () => {
    const html = renderToStaticMarkup(
      <CapsuleDetail
        capsule={{
          ...view,
          fields: { credits: '0', myCommitment: { is_some: false, value: '00' } },
          ledger: { nullifiers: [], votesFor: '1234567', votesAgainst: '0', open: true, tally: [['For', '3']] },
          abi: {
            ...view.abi,
            ledgerSignatures: {
              fields: {
                ...view.abi.ledgerSignatures.fields,
                open: { storage: 'Cell', type: { tag: 'Boolean' } },
                tally: { storage: 'Map', key: { tag: 'Enum', name: 'Choice', elements: ['For', 'Against'] }, value: { tag: 'Uint', maxval: '255' } },
              },
            },
          },
        }}
        onBack={() => {}}
      />,
    );
    expect(html).toContain('>none<');
    expect(html).toContain('>Yes<');
    expect(html).toContain('1,234,567');
    expect(html).toContain('1 entry(ies)');
    expect(html).toContain('>For<');
    expect(html).toContain('0 item(s)');
  });

  it('tells a capsule with no private state from one not yet read', () => {
    const html = renderToStaticMarkup(
      <CapsuleDetail
        capsule={{ ...view, fields: {}, abi: { ...view.abi, localStateSignatures: { fields: {}, functions: {} } } }}
        onBack={() => {}}
      />,
    );
    expect(html).toContain('This contract keeps no private state.');
    expect(html).not.toContain('not read');
  });
});
