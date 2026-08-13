import { WordChipGrid } from '@shieldedtech/moth-extension';

const WORDS = [
  'lantern', 'velvet', 'orbit', 'quiet',
  'harbor', 'maple', 'signal', 'ember',
  'willow', 'cinder', 'plume', 'north',
  'vesper', 'moth', 'tide', 'garnet',
  'drift', 'fable', 'onyx', 'meadow',
  'sparrow', 'dune', 'ivory', 'latch',
];

export const SecretPhrase = () => (
  <div style={{ maxWidth: 560 }}>
    <WordChipGrid words={WORDS} />
  </div>
);
