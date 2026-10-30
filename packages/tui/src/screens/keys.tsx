import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { WalletInfo } from '@shieldedtech/moth-wallet';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter, type HelpHint } from '../components/HelpFooter.js';
import { buildRevealView, type RevealedSecret, type RevealView } from './reveal-view.js';

interface KeysProps {
  wallets: WalletInfo[];
  isUnlocked: (name: string) => boolean;
  getAddresses: (name: string) => { unshielded: string; shielded: string; dust: string } | null;
  onUnlock: (name: string, passphrase: string) => Promise<void>;
  onLock: (name: string) => void;
  onSwitch: (name: string) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  onClearCache: (name: string) => void;
  /**
   * Recover the wallet's backup secret from the keystore. Takes a passphrase
   * because it must NOT read the unlocked session — see the reveal flow below.
   */
  onRevealPhrase: (name: string, passphrase: string) => Promise<RevealedSecret>;
  onCreateNew: () => void;
  onBack: () => void;
}

type Mode = 'list' | 'unlock' | 'reveal-confirm' | 'reveal-unlock' | 'reveal-show';

export function Keys({
  wallets, isUnlocked, getAddresses, onUnlock, onLock, onSwitch, onRemove, onClearCache,
  onRevealPhrase, onCreateNew, onBack,
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
  const [revealTarget, setRevealTarget] = useState('');
  const [revealPass, setRevealPass] = useState('');
  const [revealed, setRevealed] = useState<RevealView | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (highlighted >= itemCount) {
      setHighlighted(Math.max(0, itemCount - 1));
    }
  }, [itemCount, highlighted]);

  // Drop the secret and the passphrase together. Called on every exit from the
  // reveal flow, so walking away from the screen does not leave a phrase in
  // component state waiting to be painted again on the next render.
  const clearReveal = () => {
    setRevealed(null);
    setRevealPass('');
    setRevealTarget('');
  };

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
        out.push({ key: 'p', label: 'reveal phrase' });
        out.push({ key: 'd', label: 'delete' });
        out.push({ key: 'c', label: 'clear cache' });
      }
    }
    out.push({ key: 'ESC', label: 'back' });
    return out;
  };

  useInput((input, key) => {
    if (key.escape) {
      if (mode !== 'list') {
        clearReveal();
        setMode('list');
        setError('');
        return;
      }
      onBack();
      return;
    }
    // Confirm before the passphrase prompt, the way the CLI's `wallet
    // export-phrase` confirms before printing: the failure mode is a phrase put
    // on a screen someone else can see, and that is decided before typing, not
    // after.
    if (mode === 'reveal-confirm') {
      if (input === 'y' || input === 'Y') {
        setRevealPass('');
        setError('');
        setMode('reveal-unlock');
      } else if (input === 'n' || input === 'N') {
        clearReveal();
        setMode('list');
      }
      return;
    }
    if (mode === 'reveal-show') {
      // Enter, q or ESC (handled above) take it back off the screen. Nothing
      // else does anything here, so a stray keystroke cannot navigate away and
      // leave the phrase rendered behind another view.
      if (key.return || input === 'q') {
        clearReveal();
        setMode('list');
        setMessage('Recovery phrase hidden');
      }
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
    if (input === 'p') {
      setRevealTarget(w.name);
      setRevealed(null);
      setRevealPass('');
      setMessage('');
      setError('');
      setMode('reveal-confirm');
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

  if (mode === 'reveal-confirm') {
    return (
      <Box flexDirection="column" padding={1}>
        <SectionHeader title={`Reveal Recovery Phrase · ${revealTarget}`} />
        <Box flexDirection="column" paddingLeft={2}>
          <Text>Show the recovery phrase for <Text bold>{revealTarget}</Text> on this screen?</Text>
          <Box marginTop={1}>
            <Text color="yellow">Anyone who sees it controls the wallet.</Text>
          </Box>
          <HelpFooter hints={[{ key: 'y', label: 'show' }, { key: 'n', label: 'cancel' }, { key: 'ESC', label: 'back' }]} />
        </Box>
      </Box>
    );
  }

  if (mode === 'reveal-unlock') {
    return (
      <Box flexDirection="column" padding={1}>
        <SectionHeader title={`Reveal Recovery Phrase · ${revealTarget}`} />
        <Box flexDirection="column" paddingLeft={2}>
          {/* Asked for even when the wallet is already unlocked. The unlocked
              session holds derived keys and no seed (D-KM-3), so there is
              nothing in it to reveal — the secret comes from the keystore, and
              that needs the passphrase. Say so, or this reads as a bug. */}
          <Text dimColor>The keystore is decrypted again for this. An unlocked wallet is not enough.</Text>
          <Box marginTop={1}>
            <Text>Passphrase: </Text>
            <TextInput value={revealPass} onChange={setRevealPass} mask="*" onSubmit={async () => {
              try {
                const secret = await onRevealPhrase(revealTarget, revealPass);
                setRevealed(buildRevealView(secret));
                // The passphrase has done its job; nothing below this point
                // needs it, so it does not stay in state while the secret is up.
                setRevealPass('');
                setError('');
                setMode('reveal-show');
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

  if (mode === 'reveal-show' && revealed) {
    return (
      <Box flexDirection="column" padding={1}>
        <SectionHeader title={`Recovery Phrase · ${revealTarget}`} />
        <Box flexDirection="column" paddingLeft={2}>
          <Text bold color="yellow">
            {revealed.kind === 'mnemonic' ? '⚠ Recovery mnemonic' : '⚠ Raw seed'} — anyone who sees this controls the wallet
          </Text>
          {revealed.note && (
            <Box marginTop={1}>
              <Text dimColor>{revealed.note}</Text>
            </Box>
          )}

          <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
            {revealed.kind === 'seed'
              ? <Text>{revealed.seedHex}</Text>
              : revealed.rows.map((row, r) => (
                <Box key={r}>
                  {row.map(({ index, word }) => (
                    <Box key={index} width={14}>
                      <Text dimColor>{String(index).padStart(2, ' ')}.</Text>
                      <Text> {word}</Text>
                    </Box>
                  ))}
                </Box>
              ))}
          </Box>

          <Box marginTop={1}>
            <Text dimColor>Store it offline, never digitally.</Text>
          </Box>
          <HelpFooter hints={[{ key: 'ESC', label: 'hide' }, { key: 'Enter', label: 'hide' }]} />
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
