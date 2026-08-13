import { Badge } from '@shieldedtech/moth-extension';

export const Badges = () => (
  <div className="flex items-center gap-2">
    <Badge>First time connecting</Badge>
    <Badge>Shielded</Badge>
  </div>
);

export const InContext = () => (
  <div className="flex items-center gap-2 text-sm font-semibold">
    mUSD <Badge>Shielded</Badge>
  </div>
);
