import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Navigator, Route } from '../../navigation/index.js';

interface Props {
  route: Route<'onboarding-mnemonic-display'>;
  nav: Navigator;
}

export function MnemonicDisplayScreen({ route, nav }: Props) {
  const { partial } = route.params;
  const mnemonic = partial.generatedMnemonic ?? '';
  const words = mnemonic.split(/\s+/).filter(Boolean);
  const [confirmed, setConfirmed] = useState(false);

  useInput((input, key) => {
    if (!confirmed && (input === 'y' || input === 'Y')) {
      setConfirmed(true);
      return;
    }
    if (confirmed && key.return) {
      nav.reset('dashboard', undefined);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">⚠ Recovery mnemonic — write this down NOW</Text>
      <Box marginTop={1}>
        <Text dimColor>
          This is the only time these words will be shown. Anyone with this mnemonic
          can spend your funds. Store it offline, never digitally.
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} paddingY={0}>
        {[0, 1, 2, 3].map((row) => (
          <Box key={row}>
            {words.slice(row * 6, row * 6 + 6).map((w, i) => {
              const idx = row * 6 + i + 1;
              return (
                <Box key={idx} width={14}>
                  <Text dimColor>{String(idx).padStart(2, ' ')}.</Text>
                  <Text> {w}</Text>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        {!confirmed ? (
          <Text>Have you written these 24 words down? Press <Text color="cyan">Y</Text> to confirm.</Text>
        ) : (
          <Text>Press <Text color="cyan">Enter</Text> to continue to the dashboard.</Text>
        )}
      </Box>
    </Box>
  );
}
