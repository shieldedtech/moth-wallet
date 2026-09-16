import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import { checkSeedInput, HEX_SEED_NO_CHECKSUM_NOTE } from './seed-input.js';
import type { Navigator, Route } from '../../navigation/index.js';

interface Props {
  route: Route<'onboarding-seed'>;
  nav: Navigator;
}

export function SeedEntryScreen({ route, nav }: Props) {
  const { onComplete, partial } = route.params;
  const source = partial.source;
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  // Recomputed as the user types so an unusual length is flagged *before*
  // Enter: submitting a derivable seed navigates away, so a warning shown at
  // that point would never be read.
  const live = source === 'hex' && value.trim().length > 0 ? checkSeedInput(source, value) : undefined;

  const handleSubmit = (input: string) => {
    const check = checkSeedInput(source, input);
    if (!check.ok) {
      setError(check.error ?? 'Invalid seed.');
      return;
    }
    nav.push('onboarding-passphrase', {
      onComplete,
      partial: { ...partial, seedInput: check.value },
    });
  };

  const promptText = source === 'mnemonic'
    ? 'Enter 24-word mnemonic (space or comma separated):'
    : 'Enter wallet seed (64 hex characters, or 128 if derived from a recovery phrase):';
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
        {!error && live?.warning && <Box marginTop={1}><Text color="yellow">⚠ {live.warning}</Text></Box>}
        {source === 'hex' && (
          <Box marginTop={1}><Text dimColor>{HEX_SEED_NO_CHECKSUM_NOTE}</Text></Box>
        )}
        <BackHint />
      </Box>
    </Box>
  );
}
