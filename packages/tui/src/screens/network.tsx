import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { serverProver, SUPPORTED_NETWORKS } from '@shieldedtech/moth-wallet';
import type { NetworkState } from '../types.js';
import type { NetworkOverrides } from '../settings.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter, type HelpHint } from '../components/HelpFooter.js';

/**
 * Cardano settings as this screen needs to render them.
 *
 * `blockfrostProjectIdSet` and not the id itself: it is a credential, and the
 * screen never has a reason to show it back. Setting a new one replaces it.
 */
export interface CardanoSettingsView {
  /**
   * The Cardano network this Midnight network pairs with, or null when it has
   * none (devnet, qanet, undeployed). Derived, never chosen.
   */
  readonly effectiveNetwork: string | null;
  readonly blockfrostProjectIdSet: boolean;
}

export interface CardanoSettingsPatch {
  readonly blockfrostProjectId?: string;
}

interface NetworkProps {
  network: NetworkState;
  onSwitch: (networkId: string) => void;
  onSaveOverrides: (networkId: string, overrides: NetworkOverrides) => void;
  /**
   * Cardano config, or null while it loads (or if it failed to). The section
   * renders its own unavailable line rather than disappearing — a section that
   * is sometimes absent is harder to find than one that says why it is empty.
   */
  cardano: CardanoSettingsView | null;
  onSaveCardano: (patch: CardanoSettingsPatch) => void;
  onBack: () => void;
}




const NETWORKS: readonly string[] = SUPPORTED_NETWORKS;

type UrlField = 'nodeUrl' | 'indexerUrl' | 'proofServerUrl';

const ENDPOINT_ROWS: { field: Exclude<UrlField, 'proofServerUrl'>; label: string }[] = [
  { field: 'nodeUrl', label: 'Node' },
  { field: 'indexerUrl', label: 'Indexer' },
];

type SettingRow =
  | { kind: 'url'; field: UrlField; label: string }
  | { kind: 'prover'; label: string };

type CardanoRow =
  | { kind: 'cardanoNetwork'; label: string }
  | { kind: 'blockfrost'; label: string };

const CARDANO_ROWS: CardanoRow[] = [
  { kind: 'cardanoNetwork', label: 'Cardano' },
  { kind: 'blockfrost', label: 'Blockfrost' },
];

export function Network({ network, onSwitch, onSaveOverrides, cardano, onSaveCardano, onBack }: NetworkProps) {
  const networkCount = NETWORKS.length;
  const settingRows: SettingRow[] = [
    ...ENDPOINT_ROWS.map((row): SettingRow => ({ kind: 'url', ...row })),
    { kind: 'prover', label: 'Proving' },
    ...(network.proverType === 'server'
      ? [{ kind: 'url', field: 'proofServerUrl', label: 'Proof URL' } satisfies SettingRow]
      : []),
  ];
  const cardanoRows = CARDANO_ROWS;
  const itemCount = networkCount + settingRows.length + cardanoRows.length;

  const [highlighted, setHighlighted] = useState(() => {
    const active = NETWORKS.indexOf(network.id);
    return active >= 0 ? active : 0;
  });
  const [editField, setEditField] = useState<UrlField | 'blockfrost' | null>(null);
  const [editValue, setEditValue] = useState('');
  const [message, setMessage] = useState('');

  const isNetworkRow = highlighted < networkCount;
  const settingIndex = highlighted - networkCount;
  const settingRow = isNetworkRow || settingIndex >= settingRows.length
    ? null
    : settingRows[settingIndex] ?? null;
  const cardanoIndex = settingIndex - settingRows.length;
  const cardanoRow = cardanoIndex >= 0 ? cardanoRows[cardanoIndex] ?? null : null;

  useInput((input, key) => {
    if (key.escape) {
      if (editField) { setEditField(null); return; }
      onBack();
      return;
    }
    if (editField) return; // text input handles its own keys
    if (key.upArrow) {
      setHighlighted(i => (i <= 0 ? itemCount - 1 : i - 1));
      return;
    }
    if (key.downArrow) {
      setHighlighted(i => (i >= itemCount - 1 ? 0 : i + 1));
      return;
    }
    if (key.return) {
      if (isNetworkRow) {
        const target = NETWORKS[highlighted];
        if (target !== network.id) {
          onSwitch(target);
          setMessage(`Switched to ${target}`);
        }
      } else if (settingRow?.kind === 'prover') {
        const proverType = network.proverType === 'server' ? 'wasm' : 'server';
        onSaveOverrides(
          network.id,
          { prover: proverType === 'wasm' ? { type: 'wasm' } : serverProver(network.proofServerUrl) },
        );
        setMessage(`Proving set to ${proverType === 'wasm' ? 'local WASM' : 'proof server'}`);
      } else if (settingRow?.kind === 'url') {
        setEditValue(network[settingRow.field]);
        setEditField(settingRow.field);
        setMessage('');
      } else if (cardanoRow?.kind === 'cardanoNetwork') {
        // Not editable. The pairing is derived from the Midnight network above;
        // choosing them separately is how cNIGHT ends up registered on a chain
        // the Midnight side never reads.
        setMessage('Cardano network follows the Midnight network above');
      } else if (cardanoRow?.kind === 'blockfrost') {
        // Always starts empty. Pre-filling would mean reading the stored
        // credential back out to put it on screen, which is the one thing this
        // row is careful not to do.
        setEditValue('');
        setEditField('blockfrost');
        setMessage('');
      }
      return;
    }
  });

  const saveEdit = () => {
    if (!editField) return;
    if (editField === 'blockfrost') {
      const value = editValue.trim();
      // An empty submit is "I changed my mind", not "clear it" — clearing a
      // credential by pressing Enter on a blank field is too easy to do by
      // accident, and there is no undo.
      if (value === '') {
        setMessage('Blockfrost project ID unchanged');
      } else {
        onSaveCardano({ blockfrostProjectId: value });
        setMessage('Blockfrost project ID saved');
      }
      setEditValue('');
      setEditField(null);
      return;
    }
    const overrides: NetworkOverrides = editField === 'proofServerUrl'
      ? { prover: serverProver(editValue) }
      : { [editField]: editValue };
    onSaveOverrides(network.id, overrides);
    setMessage(`Saved ${editField}`);
    setEditField(null);
  };

  const hints = (): HelpHint[] => {
    if (editField) {
      return [
        { key: 'Enter', label: 'save' },
        { key: 'ESC', label: 'cancel' },
      ];
    }
    const out: HelpHint[] = [{ key: '↑/↓', label: 'select' }];
    if (isNetworkRow) {
      const target = NETWORKS[highlighted];
      if (target !== network.id) out.push({ key: 'Enter', label: 'switch' });
    } else if (settingRow?.kind === 'prover') {
      out.push({ key: 'Enter', label: 'toggle' });
    } else {
      out.push({ key: 'Enter', label: 'edit' });
    }
    out.push({ key: 'ESC', label: 'back' });
    return out;
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Network Configuration" />
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text>Status: </Text>
          <Text color={network.connected ? 'green' : 'red'}>
            {network.connected ? `Connected (block ${network.blockHeight})` : 'Disconnected'}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>Networks</Text>
          {NETWORKS.map((id, i) => {
            const isHi = i === highlighted;
            const isActive = id === network.id;
            return (
              <Box key={id}>
                <Text color={isHi ? 'cyan' : (isActive ? 'cyan' : undefined)} bold={isHi}>
                  {isHi ? '› ' : '  '}{id}{isActive ? ' ← active' : ''}
                </Text>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>Endpoints ({network.id})</Text>
          {settingRows.map((row, i) => {
            const idx = networkCount + i;
            const isHi = idx === highlighted;
            const editing = row.kind === 'url' && editField === row.field;
            return (
              <Box key={row.kind === 'url' ? row.field : row.kind} flexDirection="column">
                <Box>
                  <Text color={isHi ? 'cyan' : undefined} bold={isHi}>
                    {isHi ? '› ' : '  '}{row.label.padEnd(9)}
                  </Text>
                  {!editing && (
                    <Text dimColor>
                      {row.kind === 'prover'
                        ? (network.proverType === 'wasm' ? 'WASM (local)' : 'Proof server')
                        : network[row.field]}
                    </Text>
                  )}
                </Box>
                {editing && row.kind === 'url' && (
                  <Box paddingLeft={11}>
                    <TextInput value={editValue} onChange={setEditValue}
                      onSubmit={saveEdit} placeholder="https://..." />
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>Cardano (cNIGHT)</Text>
          {cardanoRows.map((row, i) => {
            const idx = networkCount + settingRows.length + i;
            const isHi = idx === highlighted;
            const editing = row.kind === 'blockfrost' && editField === 'blockfrost';
            return (
              <Box key={row.kind} flexDirection="column">
                <Box>
                  <Text color={isHi ? 'cyan' : undefined} bold={isHi}>
                    {isHi ? '› ' : '  '}{row.label.padEnd(9)}
                  </Text>
                  {!editing && row.kind === 'cardanoNetwork' && (
                    <Text dimColor>
                      {cardano?.effectiveNetwork
                        ? `${cardano.effectiveNetwork} (follows ${network.id})`
                        : `none for ${network.id}`}
                    </Text>
                  )}
                  {!editing && row.kind === 'blockfrost' && (
                    <Text color={cardano?.blockfrostProjectIdSet ? undefined : 'yellow'} dimColor={cardano?.blockfrostProjectIdSet}>
                      {cardano?.blockfrostProjectIdSet ? 'set' : 'not set — required to read Cardano'}
                    </Text>
                  )}
                </Box>
                {editing && (
                  <Box paddingLeft={11}>
                    {/* Masked: this is a credential, and a TUI sits in a
                        terminal someone may be sharing or recording. */}
                    <TextInput value={editValue} onChange={setEditValue} mask="*"
                      onSubmit={saveEdit} placeholder="Blockfrost project ID" />
                  </Box>
                )}
              </Box>
            );
          })}
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Shared with the CLI and daemon (~/.moth/config). Get a free project ID at blockfrost.io.</Text>
            <Text dimColor>MOTH_BLOCKFROST_PROJECT_ID overrides what is stored here.</Text>
          </Box>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>The selected proving method is used for wallet and dApp transactions.</Text>
          <Text dimColor>WASM runs locally and is recommended for simple transactions, such as token transfers.</Text>
          <Text dimColor>Complex transactions, such as contract calls, require a proof server.</Text>
        </Box>

        {message && <Box marginTop={1}><Text color="green">{message}</Text></Box>}

        <HelpFooter hints={hints()} />
      </Box>
    </Box>
  );
}
