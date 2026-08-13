import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export function Loader({ text }: { text: string }) {
  return (
    <Box>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text> {text}</Text>
    </Box>
  );
}
