// Contract state viewer with optional managed/ decoder.
// Layout inspired by mn-tui. See NOTICE for attribution.

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { IndexerClient } from '@shieldedtech/moth-wallet';
import { pathToFileURL } from 'node:url';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter } from '../components/HelpFooter.js';

interface ContractProps {
  indexerUrl: string;
  onBack: () => void;
}

type Step = 'address' | 'managed' | 'loading' | 'result';

export function Contract({ indexerUrl, onBack }: ContractProps) {
  const [step, setStep] = useState<Step>('address');
  const [address, setAddress] = useState('');
  const [managedPath, setManagedPath] = useState('');
  const [rawState, setRawState] = useState<string | null>(null);
  const [decodedState, setDecodedState] = useState<string | null>(null);
  const [zswapState, setZswapState] = useState<string | null>(null);
  const [balances, setBalances] = useState<Array<{ tokenType: string; amount: string }>>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useInput((input, key) => {
    if (key.escape) {
      if (step === 'result') { setStep('address'); setRawState(null); setDecodedState(null); return; }
      if (step === 'managed') { setStep('address'); return; }
      onBack();
    }
    if (step === 'result') {
      if (input === 'r') fetchState();
      if (input === 'n') { setStep('address'); setAddress(''); setRawState(null); setDecodedState(null); }
    }
  });

  const fetchState = async () => {
    setLoading(true);
    setError('');
    setDecodedState(null);
    try {
      const client = new IndexerClient(indexerUrl);
      const action = await client.getContractAction(address);
      if (!action) { setError('No contract found at this address'); setLoading(false); return; }

      setRawState(action.state);
      setZswapState(action.zswapState);
      setBalances(action.unshieldedBalances);

      // Try to decode with managed/ path if provided
      if (managedPath) {
        try {
          const contractUrl = pathToFileURL(`${managedPath}/contract/index.cjs`).href;
          const mod = await import(contractUrl);
          const ledgerFn = mod.ledger ?? mod.default?.ledger;
          if (ledgerFn) {
            const decoded = ledgerFn(Buffer.from(action.state, 'hex'));
            setDecodedState(stringifyComplex(decoded));
          }
        } catch (err) {
          setDecodedState(`(decode failed: ${err})`);
        }
      }

      setStep('result');
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Contract State" />
      <Box flexDirection="column" paddingLeft={2}>
        {step === 'address' && (
          <Box flexDirection="column">
            <Text>Contract address:</Text>
            <TextInput value={address} onChange={setAddress}
              onSubmit={() => setStep('managed')} placeholder="0x..." />
          </Box>
        )}

        {step === 'managed' && (
          <Box flexDirection="column">
            <Text>Managed/ path (optional, for decoded view):</Text>
            <TextInput value={managedPath} onChange={setManagedPath}
              onSubmit={fetchState} placeholder="./build/my-contract or press Enter to skip" />
          </Box>
        )}

        {loading && <Text color="yellow">Loading...</Text>}
        {error && <Text color="red">{error}</Text>}

        {step === 'result' && rawState && (
          <Box flexDirection="column">
            {decodedState ? (
              <>
                <Text bold>Decoded State:</Text>
                <Text wrap="wrap">{decodedState}</Text>
              </>
            ) : (
              <>
                <Text bold>Raw State (hex):</Text>
                <Text dimColor wrap="truncate-end">{rawState.slice(0, 200)}{rawState.length > 200 ? '...' : ''}</Text>
              </>
            )}

            {zswapState && (
              <Box marginTop={1} flexDirection="column">
                <Text bold>Zswap State:</Text>
                <Text dimColor wrap="truncate-end">{zswapState.slice(0, 120)}{zswapState.length > 120 ? '...' : ''}</Text>
              </Box>
            )}

            {balances.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text bold>Unshielded Balances:</Text>
                {balances.map((b, i) => (
                  <Box key={i}>
                    <Text>  {b.tokenType.slice(0, 16)}...: </Text>
                    <Text color="yellow">{b.amount}</Text>
                  </Box>
                ))}
              </Box>
            )}

            <HelpFooter hints={[
              { key: 'r', label: 'refresh' },
              { key: 'n', label: 'new address' },
              { key: 'ESC', label: 'back' },
            ]} />
          </Box>
        )}
      </Box>
    </Box>
  );
}

function stringifyComplex(value: unknown, indent = 2): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (val instanceof Uint8Array) return '0x' + Array.from(val).map(b => b.toString(16).padStart(2, '0')).join('');
    if (val instanceof Map) return Object.fromEntries(val);
    if (val instanceof Set) return [...val];
    return val;
  }, indent);
}
