import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { validateMnemonic } from '@shieldedtech/moth-wallet';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import type { Navigator, Route } from '../../navigation/index.js';

interface Props {
  route: Route<'onboarding-seed'>;
  nav: Navigator;
}

function isValidHexSeed(seed: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(seed);
}

export function SeedEntryScreen({ route, nav }: Props) {
  const { onComplete, partial } = route.params;
  const source = partial.source;
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (input: string) => {
    const trimmed = input.trim();
    if (source === 'mnemonic') {
      const normalized = trimmed.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
      if (!validateMnemonic(normalized)) {
        setError('Invalid mnemonic. Must be 24 valid BIP-39 words (space or comma separated).');
        return;
      }
      nav.push('onboarding-birthday', {
        onComplete,
        partial: { ...partial, seedInput: normalized },
      });
    } else if (source === 'hex') {
      if (!isValidHexSeed(trimmed)) {
        setError('Invalid hex seed. Must be exactly 64 hex characters (0-9, a-f).');
        return;
      }
      nav.push('onboarding-birthday', {
        onComplete,
        partial: { ...partial, seedInput: trimmed.toLowerCase() },
      });
    } else {
      setError(`Unexpected seed source: ${String(source)}`);
    }
  };

  const promptText = source === 'mnemonic'
    ? 'Enter 24-word mnemonic (space or comma separated):'
    : 'Enter wallet seed (64 hex characters):';
  const placeholder = source === 'mnemonic' ? 'word1 word2 word3…' : 'a1b2c3…';

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Enter seed" hint={promptText} />
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text>› </Text>
          <TextInput
            value={value}
            onChange={(v) => { setValue(v); setError(''); }}
            onSubmit={handleSubmit}
            placeholder={placeholder}
            mask="*"
          />
        </Box>
        {error && <Box marginTop={1}><Text color="red">✗ {error}</Text></Box>}
        <BackHint />
      </Box>
    </Box>
  );
}
