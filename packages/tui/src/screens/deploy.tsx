import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { TxStatus } from '../components/TxStatus.js';
import type { TxProgress } from '../types.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter, type HelpHint } from '../components/HelpFooter.js';

interface DeployProps {
  onDeploy: (artifactPath: string, witnessPath?: string, projectDir?: string) => Promise<string>;
  onBack: () => void;
}

type Row = 'artifact' | 'witnesses' | 'projectDir' | 'deploy';
const ROWS: Row[] = ['artifact', 'witnesses', 'projectDir', 'deploy'];
type EditField = 'artifact' | 'witnesses' | 'projectDir';

const LABELS: Record<Row, string> = {
  artifact: 'Artifact',
  witnesses: 'Witnesses',
  projectDir: 'Project',
  deploy: '',
};

const PLACEHOLDERS: Record<EditField, string> = {
  artifact: './compiled/my-contract',
  witnesses: '(optional)',
  projectDir: '(for SDK deps, blank = auto)',
};

export function Deploy({ onDeploy, onBack }: DeployProps) {
  const [highlighted, setHighlighted] = useState(0);
  const [editField, setEditField] = useState<EditField | null>(null);
  const [editValue, setEditValue] = useState('');
  const [artifactPath, setArtifactPath] = useState('');
  const [witnessPath, setWitnessPath] = useState('');
  const [projectDir, setProjectDir] = useState('');
  const [progress, setProgress] = useState<TxProgress>({ status: 'idle', message: '' });
  const [contractAddress, setContractAddress] = useState('');
  const [error, setError] = useState('');

  const busy = progress.status === 'building' || progress.status === 'proving' || progress.status === 'submitting';

  useInput((_input, key) => {
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
      if (row === 'deploy') {
        submit();
      } else {
        const current = row === 'artifact' ? artifactPath
          : row === 'witnesses' ? witnessPath
          : projectDir;
        setEditValue(current);
        setEditField(row);
      }
    }
  });

  const saveEdit = () => {
    const v = editValue.trim();
    if (editField === 'artifact') setArtifactPath(v);
    else if (editField === 'witnesses') setWitnessPath(v);
    else if (editField === 'projectDir') setProjectDir(v);
    setEditField(null);
  };

  const submit = async () => {
    if (!artifactPath.trim()) { setError('Artifact path is required'); return; }
    setContractAddress('');
    setProgress({ status: 'proving', message: 'Deploying (this may take a few minutes)...' });
    try {
      const address = await onDeploy(
        artifactPath.trim(),
        witnessPath.trim() || undefined,
        projectDir.trim() || undefined,
      );
      setContractAddress(address);
      setProgress({ status: 'done', message: `Deployed at ${address}` });
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
    if (row === 'deploy') out.push({ key: 'Enter', label: 'deploy' });
    else out.push({ key: 'Enter', label: 'edit' });
    out.push({ key: 'ESC', label: 'back' });
    return out;
  };

  const labelWidth = 11;

  const renderRow = (row: Row, content: React.ReactNode) => {
    const idx = ROWS.indexOf(row);
    const isHi = idx === highlighted;
    return (
      <Box>
        <Text color={isHi ? 'cyan' : undefined} bold={isHi}>
          {isHi ? '› ' : '  '}{LABELS[row].padEnd(labelWidth)}
        </Text>
        {content}
      </Box>
    );
  };

  const renderEditableRow = (row: EditField, value: string, emptyDisplay: React.ReactNode) => {
    if (editField === row) {
      return (
        <Box>
          <Text bold color="cyan">{'› '}{LABELS[row].padEnd(labelWidth)}</Text>
          <TextInput value={editValue} onChange={setEditValue}
            onSubmit={saveEdit} placeholder={PLACEHOLDERS[row]} />
        </Box>
      );
    }
    return renderRow(row, value ? <Text>{value}</Text> : emptyDisplay);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <SectionHeader title="Deploy Contract" />
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="column">
          {renderEditableRow('artifact', artifactPath,
            <Text dimColor italic>(required)</Text>)}
          {renderEditableRow('witnesses', witnessPath,
            <Text dimColor italic>(none)</Text>)}
          {renderEditableRow('projectDir', projectDir,
            <Text dimColor italic>(auto)</Text>)}

          {renderRow('deploy',
            <Text color={highlighted === ROWS.indexOf('deploy') ? 'cyan' : 'green'} bold>
              [ Deploy ]
            </Text>,
          )}
        </Box>

        {progress.status !== 'idle' && (
          <Box marginTop={1}>
            <TxStatus progress={progress} />
          </Box>
        )}

        {contractAddress && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="green">Contract deployed:</Text>
            <Text>{contractAddress}</Text>
          </Box>
        )}

        {error && <Box marginTop={1}><Text color="red">{error}</Text></Box>}

        <HelpFooter hints={hints()} />
      </Box>
    </Box>
  );
}
