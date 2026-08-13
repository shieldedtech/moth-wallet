import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import type { Navigator, Route } from '../../navigation/index.js';

interface Props {
  route: Route<'onboarding-unlock'>;
  nav: Navigator;
}

export function UnlockScreen({ route, nav }: Props) {
  const { walletName, onUnlock } = route.params;
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onUnlock(walletName, passphrase);
      nav.reset('dashboard', undefined);
    } catch {
      setError('Wrong passphrase. Try again.');
      setPassphrase('');
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Unlock wallet" hint={walletName} />
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text dimColor>Passphrase </Text>
          <Text color="cyan">{`> `}</Text>
          {busy ? (
            <Text dimColor>unlocking…</Text>
          ) : (
            <TextInput
              value={passphrase}
              onChange={(v) => { setPassphrase(v); setError(''); }}
              onSubmit={handleSubmit}
              mask="*"
              placeholder="********"
            />
          )}
        </Box>
        {error && <Box marginTop={1}><Text color="red">✗ {error}</Text></Box>}
        <BackHint />
      </Box>
    </Box>
  );
}
