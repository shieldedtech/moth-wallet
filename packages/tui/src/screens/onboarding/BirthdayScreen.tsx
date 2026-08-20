// Onboarding step shown only for imports: what the user knows about the seed's
// history. Without a claim the first sync walks the chain from genesis, which is
// correct but slow — around an hour of DUST events on preprod — while a bundled
// reference sits unused. Moth cannot infer this: an imported seed may hold funds
// from any height, so the answer has to come from the person importing it.
//
// One field takes either a date or a height, because a TUI reads better with one
// input than with two near-identical steps.

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { BackHint } from '../../components/BackHint.js';
import { SectionHeader } from '../../components/SectionHeader.js';
import { Select, type SelectItem } from '../../components/Select.js';
import type { Navigator, Route, BirthdayClaim } from '../../navigation/index.js';

type Mode = 'unknown' | 'tip' | 'discover' | 'specify';

const MODES: SelectItem<Mode>[] = [
  { label: "I don't know", value: 'unknown', hint: 'Scan the whole chain — always correct, up to an hour' },
  { label: 'I just generated this seed', value: 'tip', hint: 'Nothing to scan; start at the current tip' },
  {
    label: 'Look it up for me',
    value: 'discover',
    hint: 'Ask the indexer for the first unshielded transaction — unshielded only',
  },
  { label: 'Not used before…', value: 'specify', hint: 'Give a date (2026-08-01) or a block height' },
];

interface Props {
  route: Route<'onboarding-birthday'>;
  nav: Navigator;
}

export function BirthdayScreen({ route, nav }: Props) {
  const { onComplete, partial } = route.params;
  const [mode, setMode] = useState<Mode | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const advance = (birthday: BirthdayClaim | undefined) => {
    nav.push('onboarding-passphrase', { onComplete, partial: { ...partial, birthday } });
  };

  const choose = (next: Mode) => {
    if (next === 'unknown') return advance(undefined);
    if (next === 'tip') return advance({ kind: 'tip' });
    // Discovery needs no input here — the seed is already in `partial`, and the
    // lookup runs at import time where its result and caveat can be shown.
    if (next === 'discover') return advance({ kind: 'discover' });
    setMode('specify');
  };

  const submitValue = () => {
    const raw = value.trim();
    // A bare number is a height; anything else has to parse as a date. Rejecting
    // beats guessing: a claim that is too late hides funds received before it.
    if (/^\d+$/.test(raw)) {
      const height = Number(raw);
      if (height <= 0) return setError('Enter a block height above zero');
      return advance({ kind: 'height', value: height });
    }
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) return setError('Enter a date like 2026-08-01, or a block height');
    advance({ kind: 'date', value: when.toISOString() });
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Seed history" hint="When did this seed start being used?" />
      <Box flexDirection="column" paddingLeft={2}>
        {mode === 'specify' ? (
          <>
            <Box><Text>Date or block height: </Text>
              <TextInput value={value} onChange={(v) => { setValue(v); setError(''); }} onSubmit={submitValue} placeholder="2026-08-01" />
            </Box>
            {error ? <Box marginTop={1}><Text color="red">{error}</Text></Box> : null}
          </>
        ) : (
          <Select items={MODES} onSelect={choose} />
        )}
        <Box marginTop={1}>
          <Text dimColor>Answer early rather than late: too early only costs sync time, too late hides anything received before it.</Text>
        </Box>
        <BackHint />
      </Box>
    </Box>
  );
}
