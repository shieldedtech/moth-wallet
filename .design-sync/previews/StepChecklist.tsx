import { StepChecklist } from '@shieldedtech/moth-extension';

export const InProgress = () => (
  <StepChecklist
    steps={[
      { label: 'Transaction built', state: 'done' },
      { label: 'Generating proof', sub: 'Using local WASM proving.', state: 'active' },
      { label: 'Submitting to network', state: 'todo' },
    ]}
  />
);

export const ProofServerInProgress = () => (
  <StepChecklist
    steps={[
      { label: 'Transaction built', state: 'done' },
      { label: 'Generating proof', sub: 'Using the configured proof server.', state: 'active' },
      { label: 'Submitting to network', state: 'todo' },
    ]}
  />
);

export const AllDone = () => (
  <StepChecklist
    steps={[
      { label: 'Transaction built', state: 'done' },
      { label: 'Proof generated', state: 'done' },
      { label: 'Submitted to network', state: 'done' },
    ]}
  />
);
