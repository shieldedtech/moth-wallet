import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { t } from '../lib/i18n';
import { TransferRows } from '../components/screens/Approval';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

/** Each row's label in order, read off the rendered markup. */
const labels = (html: string) => [...html.matchAll(/text-muted-foreground">([^<]+)<\/span><span class="block text-\[15px\]/g)].map((m) => m[1]);

describe('TransferRows', () => {
  it('lists a transfer\'s outputs as what the user sends', () => {
    const html = renderToStaticMarkup(
      <TransferRows
        nightLabel='NIGHT'
        payload={{ outputs: [{ kind: 'shielded', type: TOKEN_A, value: '7', recipient: 'mn_shield_x' }], payFees: true }}
      />,
    );
    expect(labels(html)).toEqual([t('approval_youSend')]);
  });

  // makeIntent's inputs are what the wallet gives up; showing only the outputs
  // under "You send" hid them.
  it('lists an intent\'s inputs as what the user sends and its outputs as paid out', () => {
    const html = renderToStaticMarkup(
      <TransferRows
        nightLabel='NIGHT'
        payload={{
          inputs: [{ kind: 'unshielded', type: TOKEN_A, value: '5' }],
          outputs: [{ kind: 'shielded', type: TOKEN_B, value: '3', recipient: 'mn_shield_y' }],
          payFees: true,
        }}
      />,
    );
    expect(labels(html)).toEqual([t('approval_youSend'), t('approval_intentPaysOut')]);
  });

  it('still shows the inputs of an intent with no outputs', () => {
    const html = renderToStaticMarkup(
      <TransferRows
        nightLabel='NIGHT'
        payload={{ inputs: [{ kind: 'unshielded', type: TOKEN_A, value: '5' }], outputs: [], payFees: false }}
      />,
    );
    expect(labels(html)).toEqual([t('approval_youSend')]);
  });
});
