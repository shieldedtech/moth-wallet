import React from 'react';
import { Box, Text } from 'ink';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import { Select, type SelectItem } from '../../components/Select.js';
import type { Navigator, Route } from '../../navigation/index.js';

/** Sentinel value for the "Create new wallet" option. */
const CREATE_NEW = '__create_new__';

interface Props {
  route: Route<'onboarding-select'>;
  nav: Navigator;
}

export function WalletSelectScreen({ route, nav }: Props) {
  const { wallets, lastWallet, onComplete, onUnlock } = route.params;

  const items: SelectItem<string>[] = [
    ...wallets.map((w) => ({
      label: w.name,
      value: w.name,
      hint: `${w.network}${w.active ? ' · active' : ''}`,
    })),
    { label: 'Create new wallet', value: CREATE_NEW, hint: 'Generate or import a fresh wallet' },
  ];

  const initialIndex = lastWallet
    ? Math.max(0, items.findIndex((i) => i.value === lastWallet))
    : 0;

  const handleSelect = (value: string) => {
    if (value === CREATE_NEW) {
      nav.push('onboarding-network', { onComplete, partial: {} });
      return;
    }
    nav.push('onboarding-unlock', { walletName: value, onUnlock });
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Welcome back to Moth Wallet" hint="Select a wallet to unlock, or create a new one" />
      <Box flexDirection="column" paddingLeft={2}>
        <Select items={items} onSelect={handleSelect} initialIndex={initialIndex} />
        <Box marginTop={1}><Text dimColor>↑/↓ to move, Enter to select</Text></Box>
        <BackHint label="cancel" />
      </Box>
    </Box>
  );
}
