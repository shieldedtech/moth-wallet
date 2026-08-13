import { DustMeterCard } from '@shieldedtech/moth-extension';

export const Generating = () => (
  <DustMeterCard
    view={{ current: '38.2', max: '51.4', percent: 74, etaText: 'Full in about 3 hours' }}
    onOpen={() => {}}
  />
);

export const NearlyEmpty = () => (
  <DustMeterCard
    view={{ current: '0.1', max: '51.4', percent: 2, etaText: 'Full in about 12 hours' }}
    onOpen={() => {}}
  />
);

export const FullyGenerated = () => (
  <DustMeterCard
    view={{ current: '51.4', max: '51.4', percent: 100, etaText: 'Fully generated' }}
    onOpen={() => {}}
  />
);
