// Fresh install (no accounts yet): dark welcome panel pointing at the
// full-tab setup flow.

import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { Button } from '../ui/button';
import { PanelScreen, OrbitingMoth } from '../moth/panel';
import { nativeAssetLabelsForNetwork } from '../../lib/ui/token-labels';
import { DEFAULT_SETTINGS } from '../../lib/background/settings';

// Pass a mode only when the caller's button already made the create-vs-import
// choice (GetStarted's two buttons); an explicit mode skips the setup tab's
// Welcome screen. Omit it for ambiguous entry points like the account
// switcher's "New account", which should land on the Welcome choice.
export function openSetupTab(mode?: 'create' | 'import'): void {
  const path: `/setup.html${string}` = mode ? `/setup.html?mode=${mode}` : '/setup.html';
  void browser.tabs.create({ url: browser.runtime.getURL(path) });
}

export function GetStarted() {
  // No wallet exists yet, so there is no selected network to read — but the
  // next step creates one on DEFAULT_SETTINGS.network. Naming mainnet's assets
  // here promised NIGHT on a screen whose own button lands the user on preprod
  // holding tNIGHT.
  const labels = nativeAssetLabelsForNetwork(DEFAULT_SETTINGS.network);

  return (
    <PanelScreen dark>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
        <OrbitingMoth size={132} />
        <h1 className="m-0 font-display text-[34px] font-extrabold leading-tight">
          {t('welcome_taglineLine1')}
          <br />
          {t('welcome_taglineLine2')}
        </h1>
        <p className="m-0 text-[14.5px] text-muted-foreground">
          {t('welcome_intro', [labels.night])}
        </p>
        <Button size="lg" className="w-full" onClick={() => openSetupTab('create')}>
          {t('welcome_createWallet')}
        </Button>
        <Button variant="outline" size="lg" className="w-full border-white/40 text-foreground" onClick={() => openSetupTab('import')}>
          {t('welcome_alreadyHaveOne')}
        </Button>
        {/* Below the buttons, not in the headline: it qualifies the offer rather
            than competing with it. */}
        <p className="m-0 text-[12.5px] text-muted-foreground">{t('welcome_devNote')}</p>
      </div>
    </PanelScreen>
  );
}
