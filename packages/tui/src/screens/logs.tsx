import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { LogEntry } from '../types.js';
import { getLogPath } from '../persistent-log.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter } from '../components/HelpFooter.js';

interface LogsProps {
  entries: LogEntry[];
  onClear: () => void;
  onBack: () => void;
}

const LEVEL_COLORS: Record<LogEntry['level'], string> = {
  info: 'blue',
  warn: 'yellow',
  error: 'red',
  debug: 'gray',
};

const PAGE_SIZE = 30;

export function Logs({ entries, onClear, onBack }: LogsProps) {
  const [offset, setOffset] = useState(Math.max(0, entries.length - PAGE_SIZE));

  useInput((_input, key) => {
    if (key.escape) { onBack(); return; }
    if (_input === 'c') { onClear(); setOffset(0); return; }
    if (key.upArrow || _input === 'k') { setOffset(o => Math.max(0, o - 1)); return; }
    if (key.downArrow || _input === 'j') { setOffset(o => Math.min(Math.max(0, entries.length - PAGE_SIZE), o + 1)); return; }
    if (key.pageUp) { setOffset(o => Math.max(0, o - PAGE_SIZE)); return; }
    if (key.pageDown) { setOffset(o => Math.min(Math.max(0, entries.length - PAGE_SIZE), o + PAGE_SIZE)); return; }
    if (_input === 'g') { setOffset(0); return; } // top
    if (_input === 'G') { setOffset(Math.max(0, entries.length - PAGE_SIZE)); return; } // bottom
  });

  const visible = entries.slice(offset, offset + PAGE_SIZE);
  const atTop = offset === 0;
  const atBottom = offset >= entries.length - PAGE_SIZE;

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <SectionHeader title="Logs" />
        <Text dimColor> ({entries.length} total, {offset + 1}–{Math.min(offset + PAGE_SIZE, entries.length)})</Text>
        <Text dimColor>  {getLogPath()}</Text>
      </Box>

      <Box flexDirection="column" paddingLeft={2}>
        {!atTop && <Text dimColor>↑ more ({offset} above)</Text>}

        <Box marginTop={atTop ? 1 : 0} flexDirection="column">
          {visible.length === 0 ? (
            <Text dimColor>No log entries.</Text>
          ) : (
            visible.map((entry, i) => (
              <Box key={offset + i}>
                <Text dimColor>{entry.timestamp.slice(11, 19)} </Text>
                <Text color={LEVEL_COLORS[entry.level]}>
                  {entry.level.toUpperCase().padEnd(5)}
                </Text>
                <Text> {entry.message}</Text>
              </Box>
            ))
          )}
        </Box>

        {!atBottom && <Text dimColor>↓ more ({entries.length - offset - PAGE_SIZE} below)</Text>}

        <HelpFooter hints={[
          { key: '↑/↓', label: 'scroll' },
          { key: 'PgUp/PgDn', label: 'page' },
          { key: 'g/G', label: 'top/bottom' },
          { key: 'c', label: 'clear' },
          { key: 'ESC', label: 'back' },
        ]} />
      </Box>
    </Box>
  );
}
