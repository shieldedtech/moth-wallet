import { Input } from '@shieldedtech/moth-extension';

export const Default = () => <Input placeholder="Password" />;

export const MonoAddress = () => <Input mono readOnly value="mn_addr1qxy8k2vw0d4tz8kt4c2vx" />;

export const Invalid = () => (
  <div className="flex flex-col gap-2">
    <Input invalid defaultValue="mn_addr1x" />
    <p className="m-0 text-[12.5px] text-destructive">
      That doesn't look like a Midnight address. Check it and try again.
    </p>
  </div>
);
