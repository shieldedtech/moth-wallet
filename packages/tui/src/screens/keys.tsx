import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { WalletInfo } from '@shieldedtech/moth-wallet';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter, type HelpHint } from '../components/HelpFooter.js';

interface KeysProps {
  wallets: WalletInfo[];
  isUnlocked: (name: string) => boolean;
  getAddresses: (name: string) => { unshielded: string; shielded: string; dust: string } | null;
  onUnlock: (name: string, passphrase: string) => Promise<void>;
  onLock: (name: string) => void;
  onSwitch: (name: string) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  onClearCache: (name: string) => void;
  onCreateNew: () => void;
  onBack: () => void;
}

type Mode = 'list' | 'unlock';

export function Keys({
  wallets, isUnlocked, getAddresses, onUnlock, onLock, onSwitch, onRemove, onClearCache, onCreateNew, onBack,
}: KeysProps) {
  const [mode, setMode] = useState<Mode>('list');
  const createIndex = wallets.length;
  const itemCount = wallets.length + 1;
  const [highlighted, setHighlighted] = useState(() => {
    const active = wallets.findIndex(w => w.active);
    return active >= 0 ? active : 0;
  });
  const [unlockTarget, setUnlockTarget] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (highlighted >= itemCount) {
      setHighlighted(Math.max(0, itemCount - 1));
    }
  }, [itemCount, highlighted]);

  const hints = (): HelpHint[] => {
    const out: HelpHint[] = [{ key: '↑/↓', label: 'select' }];
    if (highlighted === createIndex) {
      out.push({ key: 'Enter', label: 'create' });
    } else {
      const w = wallets[highlighted];
      if (w) {
        if (isUnlocked(w.name)) {
          out.push({ key: 'Enter', label: 'switch' });
          out.push({ key: 'l', label: 'lock' });
        } else {
          out.push({ key: 'Enter', label: 'unlock' });
        }
        out.push({ key: 'd', label: 'delete' });
        out.push({ key: 'c', label: 'clear cache' });
      }
    }
    out.push({ key: 'ESC', label: 'back' });
    return out;
  };

  useInput((input, key) => {
    if (key.escape) {
      if (mode !== 'list') { setMode('list'); setError(''); return; }
      onBack();
      return;
    }
    if (mode !== 'list') return;
    if (key.upArrow) {
      setHighlighted(i => (i <= 0 ? itemCount - 1 : i - 1));
      return;
    }
    if (key.downArrow) {
      setHighlighted(i => (i >= itemCount - 1 ? 0 : i + 1));
      return;
    }
    if (highlighted === createIndex) {
      if (key.return) { onCreateNew(); return; }
      return;
    }
    const w = wallets[highlighted];
    if (!w) return;
    if (key.return) {
      if (isUnlocked(w.name)) {
        onSwitch(w.name).then(() => setMessage(`Switched to ${w.name}`));
      } else {
        setUnlockTarget(w.name);
        setUnlockPass('');
        setError('');
        setMode('unlock');
      }
      return;
    }
    if (input === 'l') {
      if (isUnlocked(w.name)) {
        onLock(w.name);
        setMessage(`Locked ${w.name}`);
      }
      return;
    }
    if (input === 'd') {
      onRemove(w.name).then(() => setMessage(`Removed ${w.name}`));
      return;
    }
    if (input === 'c') {
      onClearCache(w.name);
      setMessage(`Sync cache cleared for ${w.name}`);
      return;
    }
  });

  if (mode === 'unlock') {
    return (
      <Box flexDirection="column" padding={1}>
        <SectionHeader title={`Unlock Wallet · ${unlockTarget}`} />
        <Box flexDirection="column" paddingLeft={2}>
          <Box>
            <Text>Passphrase: </Text>
            <TextInput value={unlockPass} onChange={setUnlockPass} mask="*" onSubmit={async () => {
              try {
                await onUnlock(unlockTarget, unlockPass);
                setMessage(`Unlocked ${unlockTarget}`);
                setMode('list');
              } catch {
                setError('Wrong passphrase or corrupted keystore');
              }
            }} placeholder="********" />
          </Box>
          {error && <Text color="red">{error}</Text>}
          <HelpFooter hints={[{ key: 'ESC', label: 'cancel' }]} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Wallet Keys" />
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="column">
          {wallets.map((w, i) => {
            const unlocked = isUnlocked(w.name);
            const addrs = unlocked ? getAddresses(w.name) : null;
            const isHi = i === highlighted;
            return (
              <Box key={w.name} flexDirection="column" marginBottom={addrs ? 1 : 0}>
                <Box>
                  <Text color={isHi ? 'cyan' : (w.active ? 'cyan' : undefined)} bold={isHi}>
                    {isHi ? '› ' : '  '}{w.name.padEnd(20)}
                    {unlocked
                      ? <Text color="green"> unlocked</Text>
                      : <Text color="red"> locked</Text>
                    }
                    {w.active && ' ← active'}
                  </Text>
                </Box>
                {addrs && (
                  <Box flexDirection="column" paddingLeft={4}>
                    <Text dimColor>unshielded  {addrs.unshielded}</Text>
                    <Text dimColor>shielded    {addrs.shielded}</Text>
                    <Text dimColor>dust        {addrs.dust}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
          <Box marginTop={wallets.length > 0 ? 1 : 0}>
            <Text color={highlighted === createIndex ? 'cyan' : 'green'} bold={highlighted === createIndex}>
              {highlighted === createIndex ? '› ' : '  '}+ Create new wallet
            </Text>
          </Box>
        </Box>
        {message && <Box marginTop={1}><Text color="green">{message}</Text></Box>}
        {error && <Box marginTop={1}><Text color="red">{error}</Text></Box>}
        <HelpFooter hints={hints()} />
      </Box>
    </Box>
  );
}
