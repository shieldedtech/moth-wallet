// The crescent's cutout paints with var(--background), so it reads true on
// the ink (dark) surface it was designed for.
import { Crescent } from '@shieldedtech/moth-extension';

export const OnInk = () => (
  <div className="dark flex items-center gap-4 rounded-[18px] bg-background p-6">
    <Crescent size={56} />
    <Crescent size={96} />
  </div>
);

export const Small = () => (
  <div className="dark inline-flex rounded-full bg-background p-4">
    <Crescent size={40} />
  </div>
);
