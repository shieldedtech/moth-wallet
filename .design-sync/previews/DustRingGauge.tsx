import { DustRingGauge } from '@shieldedtech/moth-extension';

export const Generating = () => (
  <DustRingGauge view={{ current: '38.2', max: '51.4', percent: 74, etaText: 'Full in about 3 hours' }} />
);

export const FullyGenerated = () => (
  <DustRingGauge view={{ current: '51.4', max: '51.4', percent: 100, etaText: 'Fully generated' }} />
);

export const LargeBalance = () => (
  <DustRingGauge view={{ current: '842,150.75', max: '842,150.75', percent: 100, etaText: 'Fully generated' }} />
);
