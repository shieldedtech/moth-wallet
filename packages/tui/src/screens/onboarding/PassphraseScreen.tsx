import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import type { Navigator, Route, CompletedOnboarding } from '../../navigation/index.js';
import { completeOnboarding } from './complete.js';

interface Props {
  route: Route<'onboarding-passphrase'>;
  nav: Navigator;
}

type Field = 'first' | 'confirm';

export function PassphraseScreen({ route, nav }: Props) {
  const { onComplete, partial } = route.params;
  const [field, setField] = useState<Field>('first');
  const [first, setFirst] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const submitFirst = (v: string) => {
    if (v.length < 8) {
      setError('Passphrase must be at least 8 characters.');
      return;
    }
    setError('');
    setField('confirm');
  };

  const submitConfirm = (v: string) => {
    if (v !== first) {
      setError('Passphrases do not match. Try again.');
      setConfirm('');
      return;
    }

    const next: Partial<typeof partial> = { ...partial, passphrase: v };

    // Random source needs a mnemonic-display step after wallet creation.
    // We route through `initializing` first — the host will fire the
    // appropriate next route once generate() returns the mnemonic.
    //
    // completeOnboarding spreads `next` rather than restating its fields. The
    // hand-written version omitted `birthday`, so the claim collected two steps
    // earlier never reached app.tsx and every import synced from genesis.
    let finished: CompletedOnboarding;
    try {
      finished = completeOnboarding(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    // Bridge: app.tsx subscribes to onComplete to run the actual side effects.
    // It then redirects to mnemonic-display (random) or dashboard (import).
    nav.push('onboarding-initializing', { onComplete, partial: next });
    onComplete(finished);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Set passphrase" hint="Step 4 of 4 — Encrypts the keystore (min 8 chars)" />
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="column">
          <Box>
            <Text>{'Passphrase: '.padEnd(14)}</Text>
            {field === 'first' ? (
              <TextInput value={first} onChange={(v) => { setFirst(v); setError(''); }} onSubmit={submitFirst} mask="*" placeholder="********" />
            ) : (
              <Text>{'*'.repeat(first.length)}</Text>
            )}
          </Box>
          <Box>
            <Text>{'Confirm:    '.padEnd(14)}</Text>
            {field === 'confirm' ? (
              <TextInput value={confirm} onChange={(v) => { setConfirm(v); setError(''); }} onSubmit={submitConfirm} mask="*" placeholder="********" />
            ) : (
              <Text dimColor>(after passphrase)</Text>
            )}
          </Box>
        </Box>
        {error && <Box marginTop={1}><Text color="red">✗ {error}</Text></Box>}
        <BackHint />
      </Box>
    </Box>
  );
}
