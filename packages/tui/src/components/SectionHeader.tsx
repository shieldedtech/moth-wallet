import React from 'react';
import { Box, Text } from 'ink';

interface Chip {
  label: string;
  color?: string;
}

interface Props {
  title: string;
  /** Optional sub-text shown dimmed after the title (breadcrumb / hint). */
  hint?: string;
  /** Optional colored badges shown after the hint (e.g. PAUSED). */
  chips?: Chip[];
}

/**
 * Round-gray bordered title strip used at the top of every screen and view.
 * Mirrors midnight-wallet-cli's section heading pattern.
 */
export function SectionHeader({ title, hint, chips }: Props) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold>{title}</Text>
      {hint && (
        <>
          <Text dimColor> · </Text>
          <Text dimColor>{hint}</Text>
        </>
      )}
      {chips?.map((chip, i) => (
        <React.Fragment key={i}>
          <Text dimColor> · </Text>
          <Text bold color={chip.color ?? 'yellow'}>{chip.label}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
