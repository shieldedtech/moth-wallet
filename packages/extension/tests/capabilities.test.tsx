import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Capabilities, CapabilityCards } from '../components/screens/Capabilities';
import { DEMO_CAPABILITIES } from '../lib/capsule/demo-credential';

describe('Contract capabilities', () => {
  it('renders the demo credential by interface, function and value', () => {
    const html = renderToStaticMarkup(<CapabilityCards document={DEMO_CAPABILITIES} />);
    expect(html).toContain('authority:credential/age@1.0.0');
    expect(html).toContain('ageCredential');
    expect(html).toContain('&quot;date&quot;:&quot;631152000&quot;');
    expect(html).toContain('15151515');
  });

  it('cuts a long value and shows a string bare', () => {
    const html = renderToStaticMarkup(
      <CapabilityCards document={{ 'x:y@1.0.0': { short: 'plain', long: { bytes: 'f'.repeat(200) } } }} />,
    );
    expect(html).toContain('>plain<');
    expect(html).toContain('…');
    expect(html).not.toContain('f'.repeat(200));
  });

  it('opens on its title and intro before the runtime answers', () => {
    // Static render runs no effects: the view is still loading, so the edit button is off.
    const html = renderToStaticMarkup(<Capabilities onBack={() => {}} />);
    expect(html).toContain('Contract capabilities');
    expect(html).toContain('The dApp never sees these.');
    expect(html).toMatch(/Edit as JSON/);
  });
});
