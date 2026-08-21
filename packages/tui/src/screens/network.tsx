import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import {
  archivedReferenceHeights,
  DEFAULT_NETWORKS,
  preseedReferenceStatus,
  serverProver,
} from '@shieldedtech/moth-wallet';
import type { NetworkState } from '../types.js';
import type { NetworkOverrides } from '../settings.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter, type HelpHint } from '../components/HelpFooter.js';

interface NetworkProps {
  network: NetworkState;
  onSwitch: (networkId: string) => void;
  onSaveOverrides: (networkId: string, overrides: NetworkOverrides) => void;
  onBack: () => void;
}

const NETWORKS = Object.keys(DEFAULT_NETWORKS);

type UrlField = 'nodeUrl' | 'indexerUrl' | 'proofServerUrl';

const ENDPOINT_ROWS: { field: Exclude<UrlField, 'proofServerUrl'>; label: string }[] = [
  { field: 'nodeUrl', label: 'Node' },
  { field: 'indexerUrl', label: 'Indexer' },
];

type SettingRow =
  | { kind: 'url'; field: UrlField; label: string }
  | { kind: 'prover'; label: string };

/**
 * The lowest reference held, which is the earliest birthday that can seed.
 *
 * A reference is the chain's state at one height, not a record of the blocks
 * below it, so a birthday under every reference has nothing to seed from.
 */
function earliestSeedable(preseed: {live: number | null; archived: number[]}): number | null {
  const heights = [...preseed.archived, ...(preseed.live === null ? [] : [preseed.live])];
  return heights.length === 0 ? null : Math.min(...heights);
}

export function Network({ network, onSwitch, onSaveOverrides, onBack }: NetworkProps) {
  const networkCount = NETWORKS.length;
  const settingRows: SettingRow[] = [
    ...ENDPOINT_ROWS.map((row): SettingRow => ({ kind: 'url', ...row })),
    { kind: 'prover', label: 'Proving' },
    ...(network.proverType === 'server'
      ? [{ kind: 'url', field: 'proofServerUrl', label: 'Proof URL' } satisfies SettingRow]
      : []),
  ];
  const itemCount = networkCount + settingRows.length;

  const [highlighted, setHighlighted] = useState(() => {
    const active = NETWORKS.indexOf(network.id);
    return active >= 0 ? active : 0;
  });
  const [editField, setEditField] = useState<UrlField | null>(null);
  const [editValue, setEditValue] = useState('');
  const [message, setMessage] = useState('');
  const [preseed, setPreseed] = useState<{live: number | null; archived: number[]} | null>(null);

  // Read-only: which references this machine holds decides whether an imported
  // wallet's birthday can seed or has to walk the chain, and that is otherwise
  // invisible — a sync that starts at genesis looks the same as one that seeded.
  // Building a reference is a tens-of-minutes sync and stays a CLI job
  // (`moth preseed build`); this only reports.
  useEffect(() => {
    let cancelled = false;
    const config = {id: network.id, indexerUrl: network.indexerUrl} as Parameters<typeof preseedReferenceStatus>[0];
    void (async () => {
      try {
        const [status, archived] = await Promise.all([
          preseedReferenceStatus(config),
          archivedReferenceHeights(config),
        ]);
        if (!cancelled) setPreseed({live: status.height, archived});
      } catch {
        if (!cancelled) setPreseed(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network.id, network.indexerUrl]);

  const isNetworkRow = highlighted < networkCount;
  const settingRow = isNetworkRow ? null : settingRows[highlighted - networkCount] ?? null;

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
      }
      return;
    }
  });

  const saveEdit = () => {
    if (!editField) return;
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
          <Text bold>Pre-seed references ({network.id})</Text>
          {preseed === null ? (
            <Text dimColor>  reading…</Text>
          ) : (
            <>
              <Text dimColor>
                {'  '}latest    {preseed.live === null ? 'none — every sync starts at genesis' : `block ${preseed.live}`}
              </Text>
              <Text dimColor>
                {'  '}archived  {preseed.archived.length === 0 ? 'none' : preseed.archived.join(', ')}
              </Text>
              <Text dimColor>
                {'  '}earliest birthday that can skip the chain walk:{' '}
                {earliestSeedable(preseed) === null ? 'n/a' : earliestSeedable(preseed)}
              </Text>
            </>
          )}
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
