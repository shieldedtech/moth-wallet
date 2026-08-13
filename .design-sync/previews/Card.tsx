import { Card, Separator, TokenIcon } from '@shieldedtech/moth-extension';

export const AssetListCard = () => (
  <Card className="p-0">
    <div className="flex items-center gap-3 px-4 py-[15px]">
      <TokenIcon kind="night" />
      <span className="flex-1">
        <span className="block text-sm font-semibold">NIGHT</span>
        <span className="block text-[12.5px] text-muted-foreground">Midnight</span>
      </span>
      <span className="text-sm font-semibold">1,284.09</span>
    </div>
    <Separator />
    <div className="flex items-center gap-3 px-4 py-[15px]">
      <TokenIcon kind="shielded" />
      <span className="flex-1">
        <span className="block text-sm font-semibold">mUSD</span>
        <span className="block text-[12.5px] text-muted-foreground">Only you can see this balance</span>
      </span>
      <span className="text-sm font-semibold">250.00</span>
    </div>
  </Card>
);

export const ContentCard = () => (
  <Card className="p-4">
    <p className="m-0 text-sm font-semibold">Add your first NIGHT</p>
    <p className="m-0 mt-1 text-[13px] text-muted-foreground">
      Copy your address and send NIGHT from an exchange or another wallet.
    </p>
  </Card>
);
