import React from 'react';
import { Box, Text } from 'ink';

export interface HelpHint {
  key: string;
  label: string;
  /** Optional badge text rendered after the label (e.g. unread count). */
  badge?: string;
  badgeColor?: string;
}

interface Props {
  hints: HelpHint[];
  /** Top spacing. Defaults to 1 (matches DashboardHub style). */
  paddingTop?: number;
}

export function HelpFooter({ hints, paddingTop = 1 }: Props) {
  return (
    <Box paddingTop={paddingTop} flexWrap="wrap">
      <Text dimColor>
        {hints.map((h, i) => (
          <React.Fragment key={`${h.key}-${i}`}>
            {i > 0 && <Text dimColor> · </Text>}
            <Text bold color="cyan">{h.key}</Text>
            <Text>{' '}{h.label}</Text>
            {h.badge && (
              <Text color={h.badgeColor ?? 'yellow'}> ({h.badge})</Text>
            )}
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
}
