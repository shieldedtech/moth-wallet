import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { TxProgress } from '../types.js';

interface TxStatusProps {
  progress: TxProgress;
}

const STATUS_LABELS: Record<TxProgress['status'], string> = {
  idle: '',
  building: 'Building transaction...',
  proving: 'Generating proof...',
  submitting: 'Submitting to node...',
  confirming: 'Waiting for confirmation...',
  done: 'Transaction confirmed',
  error: 'Transaction failed',
};

export function TxStatus({ progress }: TxStatusProps) {
  if (progress.status === 'idle') return null;

  const isActive = ['building', 'proving', 'submitting', 'confirming'].includes(progress.status);
  const color = progress.status === 'done' ? 'green'
    : progress.status === 'error' ? 'red'
    : 'yellow';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {isActive && <Spinner type="dots" />}
        <Text color={color}> {STATUS_LABELS[progress.status]}</Text>
      </Box>
      {progress.message && (
        <Text dimColor>  {progress.message}</Text>
      )}
      {progress.txHash && (
        <Box>
          <Text dimColor>  TX: </Text>
          <Text>{progress.txHash}</Text>
        </Box>
      )}
    </Box>
  );
}
