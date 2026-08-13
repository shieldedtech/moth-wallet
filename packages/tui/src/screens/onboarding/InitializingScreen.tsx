import React from 'react';
import { Box, Text } from 'ink';
import { Loader } from '../../components/Loader.js';
import type { Navigator, Route } from '../../navigation/index.js';

interface Props {
  route: Route<'onboarding-initializing'>;
  nav: Navigator;
  error?: string;
}

export function OnboardingInitializingScreen({ error }: Props) {
  return (
    <Box flexDirection="column" padding={1}>
      <Loader text="Creating wallet…" />
      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}
    </Box>
  );
}
