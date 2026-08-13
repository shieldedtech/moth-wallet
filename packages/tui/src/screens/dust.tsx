// DUST screen — register / deregister NIGHT UTXOs for dust generation.
// Multi-step flow ported from midnight-wallet-cli. See NOTICE for attribution.

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { formatNight, decodeBech32mAddress, type NightUtxo } from '@shieldedtech/moth-wallet';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter, type HelpHint } from '../components/HelpFooter.js';

export type DustActionResult = { success: true; txId: string } | { success: false; error: string };

interface DustProps {
  dustAddress: string;
  synced: boolean;
  syncStatus: string;
  loadUtxos: () => Promise<NightUtxo[]>;
  onRegister: (utxos: NightUtxo[], receiver?: string) => Promise<DustActionResult>;
  onDeregister: (utxos: NightUtxo[]) => Promise<DustActionResult>;
  onBack: () => void;
}

type Action = 'register' | 'deregister';

type Mode =
  | { kind: 'action' }
  | { kind: 'loading'; action: Action }
  | { kind: 'select'; action: Action; eligible: NightUtxo[] }
  | { kind: 'address'; selected: NightUtxo[] }
  | { kind: 'confirm'; action: Action; selected: NightUtxo[]; receiver?: string }
  | { kind: 'processing'; action: Action; stage: string }
  | { kind: 'result'; action: Action; result: DustActionResult };

const ACTIONS: { id: Action; label: string; description: string }[] = [
  { id: 'register', label: 'Register', description: 'enable dust generation on NIGHT UTXOs' },
  { id: 'deregister', label: 'Deregister', description: 'stop dust generation on NIGHT UTXOs' },
];

export function Dust({ dustAddress, synced, syncStatus, loadUtxos, onRegister, onDeregister, onBack }: DustProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'action' });
  const [actionIndex, setActionIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [useDefault, setUseDefault] = useState(true);
  const [customAddress, setCustomAddress] = useState('');
  const [addressError, setAddressError] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  // Reset selection state when entering a new selection step
  const beginSelect = (action: Action, eligible: NightUtxo[]) => {
    setCursor(0);
    setSelected(new Set());
    setMode({ kind: 'select', action, eligible });
  };

  const startAction = async (action: Action) => {
    setLoadError(undefined);
    setMode({ kind: 'loading', action });
    try {
      const all = await loadUtxos();
      const eligible = action === 'register'
        ? all.filter(u => !u.registered)
        : all.filter(u => u.registered);
      beginSelect(action, eligible);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setMode({ kind: 'action' });
    }
  };

  useInput((input, key) => {
    // ESC handling per mode
    if (key.escape) {
      switch (mode.kind) {
        case 'action':
        case 'loading':
          onBack();
          return;
        case 'select':
          setMode({ kind: 'action' });
          return;
        case 'address':
          startAction('register');
          return;
        case 'confirm':
          if (mode.action === 'register') {
            setMode({ kind: 'address', selected: mode.selected });
          } else {
            startAction('deregister');
          }
          return;
        case 'processing':
          return; // ignore ESC while submitting
        case 'result':
          onBack();
          return;
      }
    }

    if (mode.kind === 'action') {
      if (!synced) return; // gate input until wallet is synced
      if (key.upArrow) { setActionIndex(i => (i <= 0 ? ACTIONS.length - 1 : i - 1)); return; }
      if (key.downArrow) { setActionIndex(i => (i >= ACTIONS.length - 1 ? 0 : i + 1)); return; }
      if (key.return) { startAction(ACTIONS[actionIndex].id); return; }
      return;
    }

    if (mode.kind === 'select') {
      const { eligible } = mode;
      if (eligible.length === 0) {
        return; // empty state — only ESC works
      }
      const hasSelectAll = eligible.length > 1;
      const total = hasSelectAll ? eligible.length + 1 : eligible.length;
      if (key.upArrow) { setCursor(c => (c <= 0 ? total - 1 : c - 1)); return; }
      if (key.downArrow) { setCursor(c => (c >= total - 1 ? 0 : c + 1)); return; }
      if (input === ' ') {
        if (hasSelectAll && cursor === 0) {
          if (selected.size === eligible.length) setSelected(new Set());
          else setSelected(new Set(eligible.map((_, i) => i)));
        } else {
          const idx = hasSelectAll ? cursor - 1 : cursor;
          setSelected(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            return next;
          });
        }
        return;
      }
      if (key.return) {
        if (selected.size === 0) return;
        const chosen = eligible.filter((_, i) => selected.has(i));
        if (mode.action === 'register') {
          setUseDefault(true);
          setCustomAddress('');
          setAddressError(undefined);
          setMode({ kind: 'address', selected: chosen });
        } else {
          setMode({ kind: 'confirm', action: 'deregister', selected: chosen });
        }
        return;
      }
      return;
    }

    if (mode.kind === 'address') {
      if (input === 'c' && useDefault) {
        setUseDefault(false);
        setCustomAddress('');
        setAddressError(undefined);
      } else if (input === 'd' && !useDefault) {
        setUseDefault(true);
        setAddressError(undefined);
      } else if (useDefault && key.return) {
        setMode({ kind: 'confirm', action: 'register', selected: mode.selected });
      }
      return;
    }

    if (mode.kind === 'confirm') {
      if (key.return) submit();
      return;
    }

    if (mode.kind === 'result') {
      // Any non-escape key returns to action menu so the user can do another op
      setMode({ kind: 'action' });
      return;
    }
  });

  const submitCustomAddress = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) { setAddressError('Address is required'); return; }
    try {
      const decoded = decodeBech32mAddress(trimmed);
      if (decoded.type !== 'dust') {
        setAddressError(`Expected dust address (mn_dust...), got ${decoded.type}`);
        return;
      }
    } catch (err) {
      setAddressError(err instanceof Error ? err.message : 'Invalid dust address');
      return;
    }
    if (mode.kind === 'address') {
      setMode({ kind: 'confirm', action: 'register', selected: mode.selected, receiver: trimmed });
    }
  };

  const submit = async () => {
    if (mode.kind !== 'confirm') return;
    const { action, selected: chosen, receiver } = mode;
    setMode({ kind: 'processing', action, stage: 'Building transaction...' });
    const result = action === 'register'
      ? await onRegister(chosen, receiver)
      : await onDeregister(chosen);
    setMode({ kind: 'result', action, result });
  };

  // Render helpers ----------------------------------------------------------

  const renderAction = () => {
    if (!synced) {
      return (
        <Box flexDirection="column">
          <Box>
            <Spinner type="dots" />
            <Text color="yellow"> Waiting for wallet sync...</Text>
          </Box>
          {syncStatus && <Text dimColor>  {syncStatus}</Text>}
          <Box marginTop={1}>
            <Text dimColor>Dust registration requires a fully synced wallet.</Text>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Text bold>What would you like to do?</Text>
        <Box marginTop={1} flexDirection="column">
          {ACTIONS.map((a, i) => {
            const isHi = i === actionIndex;
            return (
              <Box key={a.id}>
                <Text color={isHi ? 'cyan' : undefined} bold={isHi}>
                  {isHi ? '› ' : '  '}{a.label.padEnd(12)}
                </Text>
                <Text dimColor>{a.description}</Text>
              </Box>
            );
          })}
        </Box>
        {loadError && <Box marginTop={1}><Text color="red">{loadError}</Text></Box>}
      </Box>
    );
  };

  const renderLoading = (m: Extract<Mode, { kind: 'loading' }>) => (
    <Box>
      <Spinner type="dots" />
      <Text> Loading NIGHT UTXOs to {m.action}...</Text>
    </Box>
  );

  const renderSelect = (m: Extract<Mode, { kind: 'select' }>) => {
    const { eligible, action } = m;
    if (eligible.length === 0) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">
            {action === 'register'
              ? 'No unregistered NIGHT UTXOs available.'
              : 'No registered NIGHT UTXOs available.'}
          </Text>
          <Text dimColor>
            {action === 'register'
              ? 'All your NIGHT UTXOs are already registered for dust generation.'
              : 'You have no NIGHT UTXOs registered for dust generation.'}
          </Text>
        </Box>
      );
    }
    const hasSelectAll = eligible.length > 1;
    const allSelected = selected.size === eligible.length;
    const totalValue = Array.from(selected).reduce((sum, i) => sum + eligible[i].value, 0n);
    return (
      <Box flexDirection="column">
        <Text dimColor>
          Select NIGHT UTXOs to {action}:
        </Text>
        <Box marginTop={1} flexDirection="column">
          {hasSelectAll && (
            <Box>
              <Text color={cursor === 0 ? 'cyan' : undefined}>{cursor === 0 ? '› ' : '  '}</Text>
              <Text>{allSelected ? '[x]' : '[ ]'} </Text>
              <Text bold>Select all</Text>
              <Text dimColor> ({eligible.length} UTXOs)</Text>
            </Box>
          )}
          {eligible.map((u, i) => {
            const itemIndex = hasSelectAll ? i + 1 : i;
            const isCursor = cursor === itemIndex;
            const isSelected = selected.has(i);
            return (
              <Box key={i}>
                <Text color={isCursor ? 'cyan' : undefined}>{isCursor ? '› ' : '  '}</Text>
                <Text>{isSelected ? '[x]' : '[ ]'} </Text>
                <Text>UTXO {i + 1}: </Text>
                <Text bold>{formatNight(u.value)}</Text>
                <Text dimColor> NIGHT</Text>
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Selected: </Text>
          <Text bold color={selected.size > 0 ? 'green' : undefined}>{selected.size}</Text>
          <Text dimColor> UTXO{selected.size !== 1 ? 's' : ''}</Text>
          {selected.size > 0 && (
            <>
              <Text dimColor> (</Text>
              <Text bold>{formatNight(totalValue)}</Text>
              <Text dimColor> NIGHT)</Text>
            </>
          )}
        </Box>
      </Box>
    );
  };

  const renderAddress = () => (
    <Box flexDirection="column">
      <Text bold>Dust receiver address</Text>
      {useDefault ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Using this wallet's dust address:</Text>
          <Box marginTop={1}><Text color="green">{dustAddress}</Text></Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Custom dust address:</Text>
          <TextInput value={customAddress} onChange={(v) => { setCustomAddress(v); setAddressError(undefined); }}
            onSubmit={submitCustomAddress} placeholder="mn_dust..." />
          {addressError && <Text color="red">{addressError}</Text>}
        </Box>
      )}
    </Box>
  );

  const renderConfirm = (m: Extract<Mode, { kind: 'confirm' }>) => {
    const totalValue = m.selected.reduce((sum, u) => sum + u.value, 0n);
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          Confirm Dust {m.action === 'register' ? 'Registration' : 'Deregistration'}
        </Text>
        <Box marginTop={1} flexDirection="column" marginLeft={2}>
          <Box>
            <Text dimColor>UTXOs: </Text>
            <Text bold>{m.selected.length}</Text>
          </Box>
          <Box>
            <Text dimColor>Total NIGHT value: </Text>
            <Text bold>{formatNight(totalValue)}</Text>
            <Text dimColor> NIGHT</Text>
          </Box>
          {m.action === 'register' && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Dust receiver:</Text>
              <Box marginLeft={2}><Text color="green">{m.receiver ?? dustAddress}</Text></Box>
            </Box>
          )}
          {m.action === 'deregister' && (
            <Box marginTop={1}>
              <Text dimColor>These UTXOs will stop generating dust rewards.</Text>
            </Box>
          )}
        </Box>
      </Box>
    );
  };

  const renderProcessing = (m: Extract<Mode, { kind: 'processing' }>) => (
    <Box flexDirection="column">
      <Box>
        <Spinner type="dots" />
        <Text> {m.action === 'register' ? 'Registering' : 'Deregistering'} NIGHT UTXOs...</Text>
      </Box>
      <Text dimColor>  {m.stage}</Text>
    </Box>
  );

  const renderResult = (m: Extract<Mode, { kind: 'result' }>) => (
    <Box flexDirection="column">
      {m.result.success ? (
        <>
          <Text bold color="green">
            ✓ {m.action === 'register' ? 'Registration' : 'Deregistration'} submitted
          </Text>
          <Box marginTop={1}><Text dimColor>Transaction ID:</Text></Box>
          <Text>{m.result.txId}</Text>
        </>
      ) : (
        <>
          <Text bold color="red">
            ✗ {m.action === 'register' ? 'Registration' : 'Deregistration'} failed
          </Text>
          <Box marginTop={1}><Text color="red">{m.result.error}</Text></Box>
        </>
      )}
    </Box>
  );

  const hints = (): HelpHint[] => {
    switch (mode.kind) {
      case 'action':
        if (!synced) return [{ key: 'ESC', label: 'back' }];
        return [
          { key: '↑/↓', label: 'select' },
          { key: 'Enter', label: 'continue' },
          { key: 'ESC', label: 'back' },
        ];
      case 'loading':
        return [{ key: 'ESC', label: 'cancel' }];
      case 'select': {
        if (mode.eligible.length === 0) return [{ key: 'ESC', label: 'back' }];
        const out: HelpHint[] = [
          { key: '↑/↓', label: 'move' },
          { key: 'Space', label: 'toggle' },
        ];
        if (selected.size > 0) out.push({ key: 'Enter', label: 'continue' });
        out.push({ key: 'ESC', label: 'back' });
        return out;
      }
      case 'address':
        return useDefault
          ? [
              { key: 'Enter', label: 'use default' },
              { key: 'c', label: 'custom address' },
              { key: 'ESC', label: 'back' },
            ]
          : [
              { key: 'Enter', label: 'submit' },
              { key: 'd', label: 'use default' },
              { key: 'ESC', label: 'back' },
            ];
      case 'confirm':
        return [
          { key: 'Enter', label: 'confirm' },
          { key: 'ESC', label: 'back' },
        ];
      case 'processing':
        return [];
      case 'result':
        return [
          { key: 'Enter', label: 'continue' },
          { key: 'ESC', label: 'back' },
        ];
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Dust" />
      <Box flexDirection="column" paddingLeft={2}>
        {mode.kind === 'action' && renderAction()}
        {mode.kind === 'loading' && renderLoading(mode)}
        {mode.kind === 'select' && renderSelect(mode)}
        {mode.kind === 'address' && renderAddress()}
        {mode.kind === 'confirm' && renderConfirm(mode)}
        {mode.kind === 'processing' && renderProcessing(mode)}
        {mode.kind === 'result' && renderResult(mode)}
        <HelpFooter hints={hints()} />
      </Box>
    </Box>
  );
}
