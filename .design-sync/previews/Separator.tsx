import { Card, Separator } from '@shieldedtech/moth-extension';

export const BetweenRows = () => (
  <Card className="p-0">
    <div className="px-4 py-[13px] text-sm font-medium">Auto-lock</div>
    <Separator />
    <div className="px-4 py-[13px] text-sm font-medium">Change password</div>
    <Separator />
    <div className="px-4 py-[13px] text-sm font-medium">Reveal secret phrase</div>
  </Card>
);
