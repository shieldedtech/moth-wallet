import React from 'react';
import { Box, Text } from 'ink';

export function BackHint({ label = 'back' }: { label?: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>Press Esc to {label}</Text>
    </Box>
  );
}
