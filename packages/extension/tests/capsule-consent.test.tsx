import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CapsuleConsent } from '../components/screens/Approval';
import type { CapsuleConsentDTO } from '../lib/capsule/protocol';

const AUTHORITY = 'd810a07887c3b4f5a6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7261ca8';
const ISSUER = '15'.repeat(32);

const enroll: CapsuleConsentDTO = {
  kind: 'capsuleTransaction',
  origin: 'http://localhost:5175',
  account: 'Home',
  calls: [
    {
      contract: AUTHORITY,
      bundle: 'Authority',
      entrypoint: 'enroll',
      arguments: [
        {
          name: 'cred',
          presented: {
            kind: 'fields',
            fields: [
              { name: 'date', value: { kind: 'number', text: '840499200' } },
              { name: 'authority', value: { kind: 'hex', hex: ISSUER } },
              { name: 'signature', value: { kind: 'hex', hex: '00'.repeat(64) } },
            ],
          },
          rendered: { date: '840499200', authority: ISSUER, signature: '00'.repeat(64) },
          bytes: { value: ['00001932', ISSUER, '00'.repeat(64)] },
        },
      ],
    },
  ],
  reached: [],
  deploys: [],
  capabilities: [],
  ttl: '2026-10-20T20:15:55.000Z',
};

describe('Capsule transaction consent', () => {
  it('shows a call’s argument under its name as the capsule screen shows a struct, not as JSON', () => {
    const html = renderToStaticMarkup(<CapsuleConsent consent={enroll} host="localhost:5175" />);
    expect(html).toContain('Call enroll on Authority');
    expect(html).toContain('>cred<');
    expect(html).toContain('3 field(s)');
    expect(html).toContain('>date<');
    expect(html).toContain('840,499,200');
    expect(html).toContain('>authority<');
    expect(html).toContain('1515151515…151515');
    expect(html).toContain('>signature<');
    expect(html).not.toContain('&quot;date&quot;');
    // The bytes the proof commits to are a tap away, not on the screen the user reads.
    expect(html).toContain('Show the bytes the proof commits to');
    expect(html).not.toContain('00001932');
  });

  it('labels an argument by its position when the build names none, a scalar beside it', () => {
    const vote: CapsuleConsentDTO = {
      ...enroll,
      calls: [
        {
          contract: AUTHORITY,
          bundle: 'Ballot',
          entrypoint: 'vote',
          arguments: [
            { presented: { kind: 'flag', value: true }, rendered: true, bytes: { value: ['01'] } },
            { presented: { kind: 'number', text: '1760990155' }, rendered: '1760990155', bytes: { value: ['0000000068f7a0cb'] } },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(<CapsuleConsent consent={vote} host="localhost:5174" />);
    expect(html).toContain('>#0<');
    expect(html).toContain('>Yes<');
    expect(html).toContain('>#1<');
    expect(html).toContain('1,760,990,155');
  });
});
