import { PanelHeader } from '@shieldedtech/moth-extension';

export const WithBack = () => <PanelHeader title="Send" onBack={() => {}} />;

export const TitleOnly = () => <PanelHeader title="Settings" />;

export const WithTrailing = () => (
  <PanelHeader
    title="Activity"
    onBack={() => {}}
    trailing={<span className="text-[13px] font-semibold text-link">See all</span>}
  />
);
