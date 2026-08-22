import React from 'react';
import type { Navigator, Route } from '../../navigation/index.js';
import { WalletSelectScreen } from './WalletSelectScreen.js';
import { UnlockScreen } from './UnlockScreen.js';
import { NetworkSelectScreen } from './NetworkSelectScreen.js';
import { SeedSourceScreen } from './SeedSourceScreen.js';
import { NameScreen } from './NameScreen.js';
import { SeedEntryScreen } from './SeedEntryScreen.js';
import { PassphraseScreen } from './PassphraseScreen.js';
import { BirthdayScreen } from './BirthdayScreen.js';
import { MnemonicDisplayScreen } from './MnemonicDisplayScreen.js';
import { OnboardingInitializingScreen } from './InitializingScreen.js';

interface Props {
  route: Route;
  nav: Navigator;
  initError?: string;
}

/**
 * Dispatches between onboarding sub-routes. Returns null for non-onboarding
 * routes so the caller can fall through to top-level screens.
 */
export function OnboardingHost({ route, nav, initError }: Props): React.ReactElement | null {
  switch (route.name) {
    case 'onboarding-select':
      return <WalletSelectScreen route={route as Route<'onboarding-select'>} nav={nav} />;
    case 'onboarding-unlock':
      return <UnlockScreen route={route as Route<'onboarding-unlock'>} nav={nav} />;
    case 'onboarding-network':
      return <NetworkSelectScreen route={route as Route<'onboarding-network'>} nav={nav} />;
    case 'onboarding-source':
      return <SeedSourceScreen route={route as Route<'onboarding-source'>} nav={nav} />;
    case 'onboarding-name':
      return <NameScreen route={route as Route<'onboarding-name'>} nav={nav} />;
    case 'onboarding-seed':
      return <SeedEntryScreen route={route as Route<'onboarding-seed'>} nav={nav} />;
    case 'onboarding-birthday':
      return <BirthdayScreen route={route as Route<'onboarding-birthday'>} nav={nav} />;
    case 'onboarding-passphrase':
      return <PassphraseScreen route={route as Route<'onboarding-passphrase'>} nav={nav} />;
    case 'onboarding-mnemonic-display':
      return <MnemonicDisplayScreen route={route as Route<'onboarding-mnemonic-display'>} nav={nav} />;
    case 'onboarding-initializing':
      return <OnboardingInitializingScreen route={route as Route<'onboarding-initializing'>} nav={nav} error={initError} />;
    default:
      return null;
  }
}

export function isOnboardingRoute(name: string): boolean {
  return name.startsWith('onboarding-');
}
