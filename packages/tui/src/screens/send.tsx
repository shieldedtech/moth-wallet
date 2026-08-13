// Send screen — midnight-style 5-step flow:
// type (shielded/unshielded) → token → amount → address → confirm → submit.
// Layout inspired by mn-tui. See NOTICE for attribution.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet';
import { TxStatus } from '../components/TxStatus.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter } from '../components/HelpFooter.js';
import { Select, type SelectItem } from '../components/Select.js';
import type { TxProgress, WalletState } from '../types.js';

type TokenType = 'shielded' | 'unshielded';
type Step = 'type' | 'token' | 'amount' | 'address' | 'confirm' | 'submitting';

interface SendProps {
  wallet: WalletState | null;
  shieldedBalances?: Record<string, bigint>;
  unshieldedBalances?: Record<string, bigint>;
  onSend: (to: string, amount: string, shielded: boolean, tokenId: string) => Promise<void>;
  onBack: () => void;
}

const TYPE_ITEMS: SelectItem<TokenType>[] = [
  { label: 'Shielded',   value: 'shielded',   hint: 'Private transfer · shielded balance' },
  { label: 'Unshielded', value: 'unshielded', hint: 'Public transfer · unshielded balance' },
];

// NIGHT is only the native unshielded token. A shielded token with all-zeros ID
// is not NIGHT and has no known denomination — treat it as a raw-integer custom token.
const isNight = (tokenType: TokenType, tokenId: string) =>
  tokenType === 'unshielded' && tokenId === NIGHT_TOKEN_ID;

function formatTokenAmount(tokenType: TokenType, tokenId: string, raw: bigint): string {
  if (isNight(tokenType, tokenId)) {
    const major = raw / 1_000_000n;
    const minor = raw % 1_000_000n;
    return `${major}.${String(minor < 0n ? -minor : minor).padStart(6, '0')}`;
  }
  return raw.toString();
}

function tokenDisplayName(tokenType: TokenType, tokenId: string): string {
  if (isNight(tokenType, tokenId)) return 'NIGHT';
  if (tokenId.length > 16) return `${tokenId.slice(0, 8)}…${tokenId.slice(-4)}`;
  return tokenId;
}

function parseAmount(input: string, tokenType: TokenType, tokenId: string): { ok: true; raw: bigint } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Enter an amount' };
  try {
    if (isNight(tokenType, tokenId)) {
      if (trimmed.includes('.')) {
        const [int, dec = ''] = trimmed.split('.');
        const padded = dec.padEnd(6, '0').slice(0, 6);
        const raw = BigInt(int || '0') * 1_000_000n + BigInt(padded);
        return raw > 0n ? { ok: true, raw } : { ok: false, error: 'Amount must be greater than zero' };
      }
      const raw = BigInt(trimmed) * 1_000_000n;
      return raw > 0n ? { ok: true, raw } : { ok: false, error: 'Amount must be greater than zero' };
    }
    if (trimmed.includes('.')) return { ok: false, error: 'Custom tokens require whole numbers' };
    const raw = BigInt(trimmed);
    return raw > 0n ? { ok: true, raw } : { ok: false, error: 'Amount must be greater than zero' };
  } catch {
    return { ok: false, error: 'Invalid amount format' };
  }
}

export function Send({ wallet, shieldedBalances = {}, unshieldedBalances = {}, onSend, onBack }: SendProps) {
  const [step, setStep] = useState<Step>('type');
  const [tokenType, setTokenType] = useState<TokenType | null>(null);
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [amountRaw, setAmountRaw] = useState<bigint | null>(null);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TxProgress>({ status: 'idle', message: '' });

  const balances = tokenType === 'shielded' ? shieldedBalances : tokenType === 'unshielded' ? unshieldedBalances : {};
  const available = tokenId ? balances[tokenId] ?? 0n : 0n;

  useInput((_input, key) => {
    if (!key.escape) return;
    if (step === 'submitting' && progress.status === 'building') return;
    if (step === 'submitting' && (progress.status === 'done' || progress.status === 'error')) { onBack(); return; }
    if (step === 'type')    { onBack(); return; }
    if (step === 'token')   { setStep('type');    setTokenId(null); setError(''); return; }
    if (step === 'amount')  { setStep('token');   setAmountInput(''); setAmountRaw(null); setError(''); return; }
    if (step === 'address') { setStep('amount');  setAddress(''); setError(''); return; }
    if (step === 'confirm') { setStep('address'); setError(''); return; }
  });

  if (!wallet) {
    return (
      <Box flexDirection="column" padding={1}>
        <SectionHeader title="Send" />
        <Box paddingLeft={2}>
          <Text color="yellow">No wallet. Press <Text bold color="cyan">k</Text> to manage keys.</Text>
        </Box>
      </Box>
    );
  }

  const handleSubmitAmount = () => {
    if (!tokenType || !tokenId) return;
    const parsed = parseAmount(amountInput, tokenType, tokenId);
    if (!parsed.ok) { setError(parsed.error); return; }
    if (parsed.raw > available) {
      setError(`Insufficient balance. Available: ${formatTokenAmount(tokenType, tokenId, available)}`);
      return;
    }
    setAmountRaw(parsed.raw);
    setError('');
    setStep('address');
  };

  const handleSubmitAddress = () => {
    const trimmed = address.trim();
    if (!trimmed) { setError('Enter a recipient address'); return; }
    setAddress(trimmed);
    setError('');
    setStep('confirm');
  };

  const submit = async () => {
    if (!tokenType || !tokenId || amountRaw === null) return;
    setStep('submitting');
    setProgress({ status: 'building', message: 'Building transaction…' });
    try {
      await onSend(address, amountInput, tokenType === 'shielded', tokenId);
      setProgress({ status: 'done', message: 'Transfer submitted' });
    } catch (err) {
      setProgress({ status: 'error', message: String(err) });
    }
  };

  useInput((_input, key) => {
    if (step === 'confirm' && key.return) submit();
  }, { isActive: step === 'confirm' });

  const sectionHint = tokenType
    ? `${tokenType}${tokenId ? ` · ${tokenDisplayName(tokenType, tokenId)}` : ''}`
    : undefined;

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Send" hint={sectionHint} />
      <Box flexDirection="column" paddingLeft={2}>
      {step === 'type' && (
        <Box flexDirection="column">
          <Box marginBottom={1}><Text dimColor>Select transfer type:</Text></Box>
          <Select
            items={TYPE_ITEMS}
            onSelect={(t) => { setTokenType(t); setStep('token'); }}
          />
          <HelpFooter hints={[
            { key: '↑/↓', label: 'move' },
            { key: 'Enter', label: 'select' },
            { key: 'ESC', label: 'cancel' },
          ]} />
        </Box>
      )}

      {step === 'token' && tokenType && (() => {
        const entries = Object.entries(balances);
        if (entries.length === 0) {
          return (
            <Box flexDirection="column">
              <Text color="yellow">No {tokenType} tokens available for transfer.</Text>
              <HelpFooter hints={[{ key: 'ESC', label: 'back' }]} />
            </Box>
          );
        }
        const items: SelectItem<string>[] = entries.map(([id, amt]) => ({
          label: `${tokenDisplayName(tokenType, id)} · ${formatTokenAmount(tokenType, id, amt)}`,
          value: id,
          hint: isNight(tokenType, id) ? '6 decimals' : 'raw integer',
        }));
        return (
          <Box flexDirection="column">
            <Box marginBottom={1}><Text dimColor>Select token to transfer:</Text></Box>
            <Select items={items} onSelect={(id) => { setTokenId(id); setStep('amount'); }} />
            <HelpFooter hints={[
              { key: '↑/↓', label: 'move' },
              { key: 'Enter', label: 'select' },
              { key: 'ESC', label: 'back' },
            ]} />
          </Box>
        );
      })()}

      {step === 'amount' && tokenType && tokenId && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text dimColor>Available </Text>
            <Text bold>{formatTokenAmount(tokenType, tokenId, available)}</Text>
            <Text dimColor> {tokenDisplayName(tokenType, tokenId)}</Text>
          </Box>
          <Box marginBottom={1}><Text dimColor>Enter amount:</Text></Box>
          <Box>
            <Text color="cyan">{`> `}</Text>
            <TextInput
              value={amountInput}
              onChange={(v) => { setAmountInput(v); setError(''); }}
              onSubmit={handleSubmitAmount}
              placeholder={isNight(tokenType, tokenId) ? '0.000000' : '0'}
            />
          </Box>
          {error && <Box marginTop={1}><Text color="red">✗ {error}</Text></Box>}
          <HelpFooter hints={[
            { key: 'Enter', label: 'continue' },
            { key: 'ESC', label: 'back' },
          ]} />
        </Box>
      )}

      {step === 'address' && tokenType && tokenId && amountRaw !== null && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text dimColor>Amount </Text>
            <Text bold>{formatTokenAmount(tokenType, tokenId, amountRaw)}</Text>
            <Text dimColor> {tokenDisplayName(tokenType, tokenId)}</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>Enter receiver address ({tokenType === 'shielded' ? 'mn_shield-addr…' : 'mn_addr…'}):</Text>
          </Box>
          <Box>
            <Text color="cyan">{`> `}</Text>
            <TextInput
              value={address}
              onChange={(v) => { setAddress(v); setError(''); }}
              onSubmit={handleSubmitAddress}
              placeholder={tokenType === 'shielded' ? 'mn_shield-addr…' : 'mn_addr…'}
            />
          </Box>
          {error && <Box marginTop={1}><Text color="red">✗ {error}</Text></Box>}
          <HelpFooter hints={[
            { key: 'Enter', label: 'continue' },
            { key: 'ESC', label: 'back' },
          ]} />
        </Box>
      )}

      {step === 'confirm' && tokenType && tokenId && amountRaw !== null && (
        <Box flexDirection="column">
          <Box marginBottom={1}><Text bold>Confirm Transfer</Text></Box>
          <Box flexDirection="column" marginLeft={2}>
            <Box>
              <Text dimColor>Type   </Text>
              <Text color={tokenType === 'shielded' ? 'magenta' : 'blue'}>{tokenType}</Text>
            </Box>
            <Box>
              <Text dimColor>Token  </Text>
              <Text>{tokenDisplayName(tokenType, tokenId)}</Text>
            </Box>
            <Box>
              <Text dimColor>Amount </Text>
              <Text bold>{formatTokenAmount(tokenType, tokenId, amountRaw)}</Text>
            </Box>
            <Box>
              <Text dimColor>To     </Text>
              <Text>{address.length > 40 ? `${address.slice(0, 20)}…${address.slice(-12)}` : address}</Text>
            </Box>
          </Box>
          <HelpFooter hints={[
            { key: 'Enter', label: 'confirm' },
            { key: 'ESC', label: 'edit' },
          ]} />
        </Box>
      )}

      {step === 'submitting' && (
        <Box flexDirection="column" marginTop={1}>
          <TxStatus progress={progress} />
          {(progress.status === 'done' || progress.status === 'error') && (
            <HelpFooter hints={[{ key: 'ESC', label: 'return' }]} />
          )}
        </Box>
      )}
      </Box>
    </Box>
  );
}
