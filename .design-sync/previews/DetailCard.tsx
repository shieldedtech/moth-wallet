import { DetailCard } from '@shieldedtech/moth-extension';

export const TxSummary = () => (
  <DetailCard
    rows={[
      { label: 'To', value: 'mn_addr1…c2vx', mono: true },
      { label: 'From', value: 'Account 1' },
      { label: 'Network fee', value: 'Paid in DUST' },
    ]}
    total={{ label: 'Total', value: '120 NIGHT + DUST fee' }}
  />
);

export const WithFootnote = () => (
  <DetailCard
    rows={[{ label: 'Network fee', value: 'Paid in DUST' }]}
    footnote="Fees are paid with DUST, not NIGHT."
  />
);

export const RowSubLines = () => (
  <DetailCard
    rows={[
      { label: 'Generated now', value: '38.2 DUST' },
      { label: 'Total possible', sub: 'From your 1,284.09 NIGHT', value: '51.4 DUST' },
      { label: 'Generation rate', sub: 'Set by the network', value: 'Variable' },
    ]}
  />
);

export const ErrorValue = () => (
  <DetailCard
    rows={[{ label: 'Reason', value: 'Proving failed', error: true }]}
    footnote="Check the selected method under Settings → Network. Complex transactions require a proof server."
  />
);
