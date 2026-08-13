import { TokenIcon } from '@shieldedtech/moth-extension';

export const Kinds = () => (
  <div className="flex items-center gap-4">
    <span className="flex flex-col items-center gap-2">
      <TokenIcon kind="night" />
      <span className="text-[12.5px] text-muted-foreground">night</span>
    </span>
    <span className="flex flex-col items-center gap-2">
      <TokenIcon kind="shielded" />
      <span className="text-[12.5px] text-muted-foreground">shielded</span>
    </span>
    <span className="flex flex-col items-center gap-2">
      <TokenIcon kind="unshielded" />
      <span className="text-[12.5px] text-muted-foreground">unshielded</span>
    </span>
    <span className="flex flex-col items-center gap-2">
      <TokenIcon kind="dust" />
      <span className="text-[12.5px] text-muted-foreground">dust</span>
    </span>
  </div>
);

export const Sizes = () => (
  <div className="flex items-center gap-4">
    <TokenIcon kind="night" size={28} />
    <TokenIcon kind="night" size={40} />
    <TokenIcon kind="night" size={56} />
  </div>
);
