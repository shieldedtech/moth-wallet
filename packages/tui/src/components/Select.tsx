import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

export interface SelectItem<T> {
  label: string;
  value: T;
  /** Optional secondary text shown dimmed to the right of the label. */
  hint?: string;
}

interface SelectProps<T> {
  items: SelectItem<T>[];
  onSelect: (value: T) => void;
  initialIndex?: number;
  isActive?: boolean;
  /**
   * Max items to render at once. Defaults to a value derived from the terminal
   * height so the list never overflows the screen (which corrupts Ink's redraw).
   */
  maxVisible?: number;
}

/**
 * Arrow-key driven select. Up/Down to move, Enter to confirm.
 *
 * Each item renders on a SINGLE line — `label` followed by a dimmed `hint` —
 * mirroring the Wallet Keys screen. Stacking the hint on its own second line
 * doubles the row count and, on a long list, overflows the terminal, which
 * makes Ink collapse the two lines onto one (the hint overwrites the label).
 *
 * The visible items are also windowed around the cursor so a long list never
 * renders taller than the terminal; `▲/▼ N more` indicate items out of view.
 *
 * Set isActive=false when another component owns the keyboard (e.g. a
 * TextInput on the same screen) to prevent double-handling.
 */
export function Select<T>({ items, onSelect, initialIndex = 0, isActive = true, maxVisible }: SelectProps<T>) {
  const [idx, setIdx] = useState(initialIndex);
  const { stdout } = useStdout();

  useInput((_input, key) => {
    if (key.upArrow) setIdx((i) => (i <= 0 ? items.length - 1 : i - 1));
    else if (key.downArrow) setIdx((i) => (i >= items.length - 1 ? 0 : i + 1));
    else if (key.return) onSelect(items[idx].value);
  }, { isActive });

  // Each item is one line; reserve rows for surrounding chrome and the two
  // `more` indicators so the rendered block always fits the terminal.
  const rows = stdout?.rows ?? 24;
  const capacity = Math.max(3, rows - 8);
  const windowSize = Math.min(maxVisible ?? capacity, items.length);

  // Align the dimmed hint into a column after the longest label.
  const labelWidth = Math.min(28, items.reduce((m, it) => Math.max(m, it.label.length), 0));

  // Center the cursor in the window, clamped to the list bounds.
  const clampedIdx = Math.max(0, Math.min(idx, items.length - 1));
  let start = clampedIdx - Math.floor(windowSize / 2);
  start = Math.max(0, Math.min(start, items.length - windowSize));
  const end = start + windowSize;
  const hiddenAbove = start;
  const hiddenBelow = items.length - end;

  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 && <Text dimColor>  ▲ {hiddenAbove} more</Text>}
      {items.slice(start, end).map((item, local) => {
        const i = start + local;
        const active = i === clampedIdx;
        return (
          <Text key={i} color={active ? 'cyan' : undefined} bold={active}>
            {active ? '› ' : '  '}{item.label.padEnd(labelWidth)}
            {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
          </Text>
        );
      })}
      {hiddenBelow > 0 && <Text dimColor>  ▼ {hiddenBelow} more</Text>}
    </Box>
  );
}
