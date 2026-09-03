// 8c Activity (and 9d empty state): filter chips, day-grouped transaction
// rows including pending local submissions, opened from Home's "See all".

import { useState } from 'react';
import { History } from 'lucide-react';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { t } from '../../lib/i18n';
import { useActivity, useTokenNames } from '../../lib/ui/client';
import { nativeAssetLabelsForNetwork } from '../../lib/ui/token-labels';
import {
  ACTIVITY_FILTERS,
  activityRowView,
  filterActivity,
  groupActivity,
  type ActivityFilter,
} from '../../lib/ui/activity-view';
import { cn } from '../../lib/ui/cn';
import { PanelHeader, PanelScreen } from '../moth/panel';
import { ActivityRow } from '../moth/activity';

export function Activity({
  network,
  balances,
  onBack,
}: {
  network: string;
  balances: WalletBalances | null;
  onBack: () => void;
}) {
  const labels = nativeAssetLabelsForNetwork(network);
  const entries = useActivity(balances);
  const { names: tokenNames } = useTokenNames();
  const [filter, setFilter] = useState<ActivityFilter>('all');

  const filterLabels: Record<ActivityFilter, string> = {
    all: t('activity_filterAll'),
    sent: t('activity_filterSent'),
    received: t('activity_filterReceived'),
    dust: labels.dust,
  };

  const groups = groupActivity(filterActivity(entries ?? [], filter));

  return (
    <PanelScreen>
      <PanelHeader title={t('activity_title')} onBack={onBack} />

      <div className="flex gap-2">
        {ACTIVITY_FILTERS.map((option) => (
          <button
            key={option}
            onClick={() => setFilter(option)}
            aria-pressed={option === filter}
            className={cn(
              'h-8 cursor-pointer rounded-full border-0 px-3.5 text-[13px] font-semibold transition duration-150 active:scale-[0.97]',
              option === filter
                ? 'bg-secondary text-secondary-foreground dark:bg-primary dark:text-primary-foreground'
                : 'bg-muted text-foreground hover:bg-border',
            )}
          >
            {filterLabels[option]}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        entries !== null && (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 pb-16 text-center">
            <span className="mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-muted text-foreground">
              <History size={28} strokeWidth={2} aria-hidden />
            </span>
            <p className="m-0 font-display text-base font-bold">{t('activity_emptyTitle')}</p>
            <p className="m-0 text-[13px] text-muted-foreground">{t('activity_emptyBody')}</p>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-4 pb-2">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="section-label mb-1">{group.label}</p>
              {group.entries.map((entry) => (
                <ActivityRow key={entry.hash} view={activityRowView(entry, labels, undefined, tokenNames)} />
              ))}
            </div>
          ))}
        </div>
      )}
    </PanelScreen>
  );
}
