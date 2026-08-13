import { useCallback, useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import type { OriginGrant } from '../../lib/background/permissions';
import { Button } from '../ui/button';
import { Card, Separator } from '../ui/card';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { originHost } from '../moth/dapp';

export function ConnectedSites({ onBack }: { onBack: () => void }) {
  const [grants, setGrants] = useState<Record<string, OriginGrant> | null>(null);

  const refresh = useCallback(async () => {
    setGrants(await sendMessage('permissionsList', undefined));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const origins = Object.keys(grants ?? {}).sort();

  return (
    <PanelScreen>
      <PanelHeader title={t('sites_title')} onBack={onBack} />
      {grants && origins.length === 0 && (
        <div className="flex flex-col items-center gap-3 pt-16 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Globe size={24} className="text-muted-foreground" />
          </span>
          <p className="m-0 font-display text-lg font-bold">{t('sites_emptyTitle')}</p>
          <p className="m-0 text-[13px] text-muted-foreground">{t('sites_emptyBody')}</p>
        </div>
      )}
      {origins.length > 0 && (
        <Card className="p-0">
          {origins.map((origin, index) => (
            <div key={origin}>
              {index > 0 && <Separator />}
              <div className="flex items-center gap-3 px-4 py-[13px]">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted font-display text-sm font-bold">
                  {originHost(origin).charAt(0).toUpperCase()}
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{originHost(origin)}</span>
                  <span className="block text-xs text-muted-foreground">{grants![origin]!.networkId}</span>
                </span>
                <Button
                  variant="chip"
                  size="sm"
                  onClick={() => void sendMessage('permissionsRevoke', { origin }).then(refresh)}
                >
                  {t('sites_revoke')}
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </PanelScreen>
  );
}
