import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import type { Navigator, Route } from '../../navigation/index.js';

interface Props {
  route: Route<'onboarding-name'>;
  nav: Navigator;
}

export function NameScreen({ route, nav }: Props) {
  const { onComplete, partial } = route.params;
  const [value, setValue] = useState(partial.name ?? '');
  const [error, setError] = useState('');

  const handleSubmit = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      setError('Name cannot be empty.');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError('Name may only contain letters, digits, hyphen, underscore.');
      return;
    }
    const next = { ...partial, name: trimmed };
    // Random source skips the seed-entry step.
    if (partial.source === 'random') {
      nav.push('onboarding-passphrase', { onComplete, partial: next });
    } else {
      nav.push('onboarding-seed', { onComplete, partial: next });
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Wallet name" hint="Step 3 of 4 — Local label for this wallet" />
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text>› </Text>
          <TextInput value={value} onChange={(v) => { setValue(v); setError(''); }} onSubmit={handleSubmit} placeholder="my-wallet" />
        </Box>
        {error && <Box marginTop={1}><Text color="red">✗ {error}</Text></Box>}
        <BackHint />
      </Box>
    </Box>
  );
}
