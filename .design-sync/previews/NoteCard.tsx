import { NoteCard } from '@shieldedtech/moth-extension';
import { Eye, Moon, TriangleAlert } from 'lucide-react';

export const Info = () => (
  <NoteCard icon={Moon}>Only send Midnight native tokens here. Anything else may be lost.</NoteCard>
);

export const Neutral = () => (
  <NoteCard variant="neutral" icon={Eye}>
    NIGHT is unshielded, this transfer will be visible on the network.
  </NoteCard>
);

export const Error = () => (
  <NoteCard variant="error" icon={TriangleAlert}>
    Not enough DUST yet. It refills on its own from your NIGHT, you'll have enough in about 12 minutes.
  </NoteCard>
);
