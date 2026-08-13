import React from 'react';
import { Box, Text } from 'ink';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import { Select, type SelectItem } from '../../components/Select.js';
import type { Navigator, Route, SeedSource } from '../../navigation/index.js';

const SOURCES: SelectItem<SeedSource>[] = [
  { label: 'Generate new (random)', value: 'random',   hint: '24-word mnemonic will be shown for you to save' },
  { label: 'Import mnemonic',       value: 'mnemonic', hint: '24 BIP-39 words' },
  { label: 'Import hex seed',       value: 'hex',      hint: '64 hex characters' },
];

interface Props {
  route: Route<'onboarding-source'>;
  nav: Navigator;
}

export function SeedSourceScreen({ route, nav }: Props) {
  const { onComplete, partial } = route.params;
  const initialIndex = partial.source ? Math.max(0, SOURCES.findIndex((s) => s.value === partial.source)) : 0;

  const handleSelect = (source: SeedSource) => {
    nav.push('onboarding-name', {
      onComplete,
      partial: { ...partial, source },
    });
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Seed source" hint="Step 2 of 4 — How do you want to provide the wallet seed?" />
      <Box flexDirection="column" paddingLeft={2}>
        <Select items={SOURCES} onSelect={handleSelect} initialIndex={initialIndex} />
        <Box marginTop={1}><Text dimColor>↑/↓ to move, Enter to select</Text></Box>
        <BackHint />
      </Box>
    </Box>
  );
}
