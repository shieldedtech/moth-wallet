// Modal overlay that interrupts the current TUI screen when an
// external CLI client requests approval for a write operation through
// the daemon socket. Subscribes to the confirmation queue and renders
// the head entry until the user answers y/n.
//
// Lives at the top of <App/> so it can capture input even when the
// active screen is doing the same — Ink's useInput obeys isActive, so
// the modal grabs keystrokes while it is mounted and the underlying
// screen's input handlers stay quiet.

import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {ConfirmationQueue, ConfirmationRequest} from '@shieldedtech/moth-wallet';

interface Props {
  queue: ConfirmationQueue;
}

export function ConfirmationModal({queue}: Props): React.ReactElement | null {
  const [current, setCurrent] = useState<ConfirmationRequest | null>(queue.peek());

  useEffect(() => {
    const sync = () => setCurrent(queue.peek());
    sync();
    return queue.subscribe(sync);
  }, [queue]);

  useInput(
    (input) => {
      if (!current) return;
      const key = input.toLowerCase();
      if (key === 'y') queue.resolve(true);
      else if (key === 'n') queue.resolve(false);
    },
    {isActive: current !== null},
  );

  if (!current) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      paddingY={1}
    >
      <Text bold color="yellow">
        External request from CLI
      </Text>
      <Box marginTop={1}>
        <Text>{current.summary}</Text>
      </Box>
      {current.details && current.details.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {current.details.map((d, i) => (
            <Text key={i} dimColor>
              · {d}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          Approve? <Text bold>[y]</Text>es / <Text bold>[n]</Text>o
        </Text>
      </Box>
    </Box>
  );
}
