import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Capabilities, CapabilityCards } from '../components/screens/Capabilities';

describe('Contract capabilities', () => {
  it('renders an installed credential by interface, function and value, the value as the capsule screen shows a struct', () => {
    const document = {
      'authority:credential/age@1.0.0': {
        ageCredential: { date: '631152000', issuer: '15'.repeat(32), signature: '00'.repeat(64) },
      },
    };
    const html = renderToStaticMarkup(<CapabilityCards document={document} />);
    expect(html).toContain('authority:credential/age@1.0.0');
    expect(html).toContain('ageCredential');
    // A struct is rows, not JSON: the date's digits grouped, the issuer and the signature truncated and copyable whole.
    expect(html).toContain('3 field(s)');
    expect(html).toContain('>date<');
    expect(html).toContain('631,152,000');
    expect(html).toContain('>issuer<');
    expect(html).toContain('1515151515…151515');
    expect(html).toContain(`title="${'15'.repeat(32)}"`);
    expect(html).not.toContain('&quot;date&quot;');
  });

  it('shows a word bare and cuts bytes, whatever the interface', () => {
    const html = renderToStaticMarkup(
      <CapabilityCards document={{ 'x:y@1.0.0': { short: 'plain', long: { bytes: 'f'.repeat(200) } } }} />,
    );
    expect(html).toContain('>plain<');
    expect(html).toContain('ffffffffff…ffffff');
    expect(html).not.toContain(`>${'f'.repeat(200)}<`);
  });

  it('opens on its title and intro before the runtime answers', () => {
    // Static render runs no effects: the view is still loading, so the edit button is off.
    const html = renderToStaticMarkup(<Capabilities onBack={() => {}} />);
    expect(html).toContain('Contract capabilities');
    expect(html).toContain('The dApp never sees these.');
    expect(html).toMatch(/Edit as JSON/);
  });
});
