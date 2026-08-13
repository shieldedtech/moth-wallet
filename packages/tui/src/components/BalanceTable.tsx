import React from 'react';
import { Box, Text } from 'ink';

interface BalanceTableProps {
  nightBalance: string;
  dustBalance: string;
  synced: boolean;
}

export function BalanceTable({ nightBalance, dustBalance, synced }: BalanceTableProps) {
  const syncIndicator = synced ? '●' : '○';
  const syncColor = synced ? 'green' : 'yellow';

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{'Token'.padEnd(10)}</Text>
        <Text bold>{'Balance'.padEnd(20)}</Text>
        <Text bold>Sync</Text>
      </Box>
      <Box>
        <Text>{'NIGHT'.padEnd(10)}</Text>
        <Text color="yellow">{(nightBalance || '0').padEnd(20)}</Text>
        <Text color={syncColor}>{syncIndicator}</Text>
      </Box>
      <Box>
        <Text>{'DUST'.padEnd(10)}</Text>
        <Text color="magenta">{(dustBalance || '0').padEnd(20)}</Text>
        <Text color={syncColor}>{syncIndicator}</Text>
      </Box>
    </Box>
  );
}
