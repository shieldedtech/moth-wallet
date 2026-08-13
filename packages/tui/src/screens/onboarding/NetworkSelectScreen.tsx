import React from 'react';
import { Box, Text } from 'ink';
import { DEFAULT_NETWORKS } from '@shieldedtech/moth-wallet';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import { Select } from '../../components/Select.js';
import type { Navigator, Route } from '../../navigation/index.js';

const NETWORKS = Object.keys(DEFAULT_NETWORKS);
const ITEMS = NETWORKS.map((id) => ({ label: id, value: id }));

interface Props {
  route: Route<'onboarding-network'>;
  nav: Navigator;
}

export function NetworkSelectScreen({ route, nav }: Props) {
  const { onComplete, partial } = route.params;
  const initialIndex = partial.network ? Math.max(0, NETWORKS.indexOf(partial.network)) : 0;

  const handleSelect = (network: string) => {
    nav.push('onboarding-source', {
      onComplete,
      partial: { ...partial, network },
    });
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Welcome to Moth Wallet" hint="Step 1 of 4 — Select network" />
      <Box flexDirection="column" paddingLeft={2}>
        <Select items={ITEMS} onSelect={handleSelect} initialIndex={initialIndex} />
        <Box marginTop={1}><Text dimColor>↑/↓ to move, Enter to select</Text></Box>
        <BackHint label="cancel onboarding" />
      </Box>
    </Box>
  );
}
