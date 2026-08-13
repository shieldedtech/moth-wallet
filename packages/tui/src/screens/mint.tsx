// Mint screen — shielded/unshielded selection, auto-deploy FT contract.
// Layout inspired by mn-tui. See NOTICE for attribution.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { TxStatus } from '../components/TxStatus.js';
import type { TxProgress } from '../types.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter, type HelpHint } from '../components/HelpFooter.js';

interface MintProps {
  onMint: (contractAddress: string, amount: string, shielded: boolean, recipient: string) => Promise<void>;
  onDeployFT?: () => Promise<string>;
  /** Active wallet's own shielded address — the default mint recipient in shielded mode. */
  defaultShieldedRecipient?: string;
  /** Active wallet's own unshielded address — the default mint recipient in unshielded mode. */
  defaultUnshieldedRecipient?: string;
  onBack: () => void;
}

type Row = 'type' | 'recipient' | 'contract' | 'amount' | 'mint';
const ROWS: Row[] = ['type', 'recipient', 'contract', 'amount', 'mint'];
type EditField = 'contract' | 'amount' | 'recipient';

export function Mint({ onMint, onDeployFT, defaultShieldedRecipient, defaultUnshieldedRecipient, onBack }: MintProps) {
  const [highlighted, setHighlighted] = useState(0);
  const [editField, setEditField] = useState<EditField | null>(null);
  const [editValue, setEditValue] = useState('');
  const [mintType, setMintType] = useState<'shielded' | 'unshielded'>('shielded');
  const [contractAddress, setContractAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');

  // When the recipient field is left blank, mint to the active wallet's own
  // address for the selected token type.
  const effectiveRecipient = recipient.trim()
    || (mintType === 'shielded' ? (defaultShieldedRecipient ?? '') : (defaultUnshieldedRecipient ?? ''));
  const [progress, setProgress] = useState<TxProgress>({ status: 'idle', message: '' });
  const [error, setError] = useState('');

  const busy = progress.status === 'building' || progress.status === 'proving' || progress.status === 'submitting';

  useInput((input, key) => {
    if (key.escape) {
      if (editField) { setEditField(null); return; }
      if (busy) return;
      onBack();
      return;
    }
    if (editField || busy) return;

    if (key.upArrow) {
      setHighlighted(i => (i <= 0 ? ROWS.length - 1 : i - 1));
      return;
    }
    if (key.downArrow) {
      setHighlighted(i => (i >= ROWS.length - 1 ? 0 : i + 1));
      return;
    }
    if (key.return) {
      const row = ROWS[highlighted];
      setError('');
      if (row === 'type') {
        setMintType(t => t === 'shielded' ? 'unshielded' : 'shielded');
      } else if (row === 'recipient') {
        setEditValue(recipient);
        setEditField('recipient');
      } else if (row === 'contract') {
        setEditValue(contractAddress);
        setEditField('contract');
      } else if (row === 'amount') {
        setEditValue(amount);
        setEditField('amount');
      } else if (row === 'mint') {
        doMint();
      }
    }
  });

  const saveEdit = () => {
    if (editField === 'contract') setContractAddress(editValue.trim());
    else if (editField === 'amount') setAmount(editValue.trim());
    else if (editField === 'recipient') setRecipient(editValue.trim());
    setEditField(null);
  };

  const doMint = async () => {
    if (!amount) { setError('Amount is required'); return; }
    const finalRecipient = effectiveRecipient;
    if (!finalRecipient) { setError('Recipient is required'); return; }
    let addr = contractAddress;
    if (!addr) {
      if (!onDeployFT) { setError('Contract address is required'); return; }
      setProgress({ status: 'building', message: 'Deploying fungible token contract...' });
      try {
        addr = await onDeployFT();
        setContractAddress(addr);
      } catch (err) {
        setProgress({ status: 'error', message: String(err) });
        return;
      }
    }
    setProgress({ status: 'proving', message: `Minting ${amount} tokens (${mintType})...` });
    try {
      await onMint(addr, amount, mintType === 'shielded', finalRecipient);
      setProgress({ status: 'done', message: 'Minting complete' });
    } catch (err) {
      setProgress({ status: 'error', message: String(err) });
    }
  };

  const hints = (): HelpHint[] => {
    if (editField) {
      return [
        { key: 'Enter', label: 'save' },
        { key: 'ESC', label: 'cancel' },
      ];
    }
    if (busy) return [];
    const out: HelpHint[] = [{ key: '↑/↓', label: 'select' }];
    const row = ROWS[highlighted];
    if (row === 'type') out.push({ key: 'Enter', label: 'toggle' });
    else if (row === 'recipient' || row === 'contract' || row === 'amount') out.push({ key: 'Enter', label: 'edit' });
    else if (row === 'mint') out.push({ key: 'Enter', label: 'mint' });
    out.push({ key: 'ESC', label: 'back' });
    return out;
  };

  const labelWidth = 10;

  const renderRow = (row: Row, content: React.ReactNode) => {
    const idx = ROWS.indexOf(row);
    const isHi = idx === highlighted;
    const label = row === 'mint' ? '' : row.charAt(0).toUpperCase() + row.slice(1);
    return (
      <Box>
        <Text color={isHi ? 'cyan' : undefined} bold={isHi}>
          {isHi ? '› ' : '  '}{label.padEnd(labelWidth)}
        </Text>
        {content}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Mint Tokens" />
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="column">
          {renderRow('type',
            <Box>
              <Text color={mintType === 'shielded' ? 'cyan' : undefined} bold={mintType === 'shielded'}>
                Shielded
              </Text>
              <Text dimColor> · </Text>
              <Text color={mintType === 'unshielded' ? 'cyan' : undefined} bold={mintType === 'unshielded'}>
                Unshielded
              </Text>
            </Box>,
          )}

          {editField === 'recipient' ? (
            <Box>
              <Text bold color="cyan">{'› '}{'Recipient'.padEnd(labelWidth)}</Text>
              <TextInput value={editValue} onChange={setEditValue}
                onSubmit={saveEdit}
                placeholder={mintType === 'shielded' ? 'mn_shield-addr… (blank = your wallet)' : 'mn_addr… (blank = your wallet)'} />
            </Box>
          ) : (
            renderRow('recipient',
              recipient
                ? <Text dimColor>{recipient}</Text>
                : (effectiveRecipient
                    ? <Text dimColor>{effectiveRecipient} <Text italic>(self)</Text></Text>
                    : <Text dimColor italic>(required)</Text>),
            )
          )}

          {editField === 'contract' ? (
            <Box>
              <Text bold color="cyan">{'› '}{'Contract'.padEnd(labelWidth)}</Text>
              <TextInput value={editValue} onChange={setEditValue}
                onSubmit={saveEdit} placeholder="0x... or leave blank to auto-deploy" />
            </Box>
          ) : (
            renderRow('contract',
              contractAddress
                ? <Text dimColor>{contractAddress}</Text>
                : <Text dimColor italic>{onDeployFT ? '(auto-deploy on mint)' : '(required)'}</Text>,
            )
          )}

          {editField === 'amount' ? (
            <Box>
              <Text bold color="cyan">{'› '}{'Amount'.padEnd(labelWidth)}</Text>
              <TextInput value={editValue} onChange={setEditValue}
                onSubmit={saveEdit} placeholder="1000" />
            </Box>
          ) : (
            renderRow('amount',
              amount
                ? <Text>{amount}</Text>
                : <Text dimColor italic>(required)</Text>,
            )
          )}

          {renderRow('mint',
            <Text color={highlighted === ROWS.indexOf('mint') ? 'cyan' : 'green'} bold>
              [ Mint ]
            </Text>,
          )}
        </Box>

        {progress.status !== 'idle' && (
          <Box marginTop={1}>
            <TxStatus progress={progress} />
          </Box>
        )}
        {error && <Box marginTop={1}><Text color="red">{error}</Text></Box>}

        <HelpFooter hints={hints()} />
      </Box>
    </Box>
  );
}
