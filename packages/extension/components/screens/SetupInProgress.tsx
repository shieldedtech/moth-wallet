// Shown while a setup tab is creating or importing an account. The panel
// takes over again once setup is complete (the tab releases its port after the
// phrase backup / done step) or the tab is closed.

import { LoaderCircle } from 'lucide-react';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import { Button } from '../ui/button';
import { PanelScreen } from '../moth/panel';

export function SetupInProgress() {
  return (
    <PanelScreen dark>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <LoaderCircle size={36} strokeWidth={2} className="animate-spin text-primary" />
        <h1 className="m-0 font-display text-[28px] font-extrabold">{t('welcome_settingUpAccount')}</h1>
        <p className="m-0 text-[13.5px] text-muted-foreground">
          {t('welcome_finishInSetupTab')}
        </p>
        <Button
          variant="outline"
          size="lg"
          className="border-white/40 text-foreground"
          onClick={() => void sendMessage('setupTabFocus', undefined)}
        >
          {t('welcome_goToSetupTab')}
        </Button>
        <button
          onClick={() => void sendMessage('setupTabClose', undefined)}
          className="cursor-pointer border-0 bg-transparent text-[13px] text-muted-foreground underline-offset-2 hover:underline"
        >
          {t('welcome_cancelSetup')}
        </button>
      </div>
    </PanelScreen>
  );
}
