import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MothMark, OrbitingMoth } from '../components/moth/panel';

// The mark ships as the extension's identity, so the things that would quietly
// break it — a hardcoded colour, colliding ids, a wing that stops moving — are
// worth pinning even though the shape itself cannot be asserted here.
describe('MothMark', () => {
  it('takes its colour from the theme, never a literal', () => {
    // A hex here would survive a palette change and silently desync from
    // everything else on the screen.
    const html = renderToStaticMarkup(<MothMark />);
    expect(html).toContain('var(--primary)');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('gives each instance its own ids, so two on one page do not collide', () => {
    const html = renderToStaticMarkup(
      <>
        <MothMark />
        <MothMark />
      </>,
    );
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('beats by default and holds still when asked not to', () => {
    expect(renderToStaticMarkup(<MothMark />)).toContain('wingbeat');
    expect(renderToStaticMarkup(<MothMark beat={false} />)).not.toContain('wingbeat');
  });

  it('mirrors one authored wing rather than drawing two', () => {
    // Two hand-drawn halves drift apart the first time either is edited.
    const html = renderToStaticMarkup(<MothMark />);
    expect(html.match(/<use /g)).toHaveLength(2);
    expect(html).toContain('scale(-1 1)');
  });
});

describe('OrbitingMoth', () => {
  it('counter-rotates the moth against its ring', () => {
    // Carried by a spinning parent without this the moth cartwheels, and a moth
    // on its back reads as a dead one.
    const html = renderToStaticMarkup(<OrbitingMoth />);
    expect(html).toContain('spin_10s_linear_infinite]');
    expect(html).toContain('spin_10s_linear_infinite_reverse]');
  });

  it('still renders the crescent the moth is circling', () => {
    const html = renderToStaticMarkup(<OrbitingMoth />);
    expect(html.match(/<svg/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
