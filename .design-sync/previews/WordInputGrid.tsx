import { WordInputGrid } from '@shieldedtech/moth-extension';

const WORDS = [
  'lantern', 'velvet', 'orbit', 'quiet',
  'harbor', 'maple', 'signal', 'ember',
  'willow', 'cinder', 'plume', 'north',
  'vesper', 'moth', 'tide', 'garnet',
  'drift', 'fable', 'onyx', 'meadow',
  'sparrow', 'dune', 'ivory', 'latch',
];

export const PartiallyFilled = () => (
  <div style={{ maxWidth: 560 }}>
    <WordInputGrid words={[...WORDS.slice(0, 5), ...Array(19).fill('')]} onChange={() => {}} />
  </div>
);

export const Filled = () => (
  <div style={{ maxWidth: 560 }}>
    <WordInputGrid words={WORDS} onChange={() => {}} />
  </div>
);
