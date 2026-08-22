// Typed stack navigation — pattern ported from midnight-wallet-cli (Apache-2.0).

import type { WalletInfo } from '@shieldedtech/moth-wallet';

export type SeedSource = 'mnemonic' | 'hex' | 'random';

/**
 * What the user asserts about an imported seed's history. Re-exported from core
 * so the TUI, CLI and extension cannot drift on what the options are or what
 * each one means.
 */
import type { BirthdayClaim } from '@shieldedtech/moth-wallet';
export type { BirthdayClaim };

export interface OnboardingState {
  network: string;
  source: SeedSource;
  name: string;
  /** mnemonic (24 words) or hex (64 chars). Undefined when source is 'random'. */
  seedInput?: string;
  passphrase: string;
  /** Mnemonic returned from generate(); shown on the ack screen. */
  generatedMnemonic?: string;
  /** Import only. Absent for a generated wallet, which gets its birthday from
   *  the chain tip automatically. */
  birthday?: BirthdayClaim;
}

export type CompletedOnboarding = Required<
  Omit<OnboardingState, 'seedInput' | 'generatedMnemonic' | 'birthday'>
> &
  Pick<OnboardingState, 'seedInput' | 'generatedMnemonic' | 'birthday'>;

export type OnComplete = (state: CompletedOnboarding) => void;
/** Called by the unlock screen with the passphrase; resolves on success, rejects on bad passphrase. */
export type OnUnlock = (name: string, passphrase: string) => Promise<void>;

/**
 * The dashboard is the single top-level route — its sub-views (send, deploy,
 * mint, contract, keys, dust, network, logs) live inside DashboardHub and are
 * dispatched by letter shortcuts, not by the navigator. The onboarding flow
 * is the only multi-step push/pop sub-stack.
 */
export type Routes = {
  dashboard: undefined;

  /** Pick an existing wallet to unlock, or branch into the create flow. */
  'onboarding-select': { wallets: readonly WalletInfo[]; lastWallet: string | null; onComplete: OnComplete; onUnlock: OnUnlock };
  /** Passphrase prompt for an existing wallet. */
  'onboarding-unlock': { walletName: string; onUnlock: OnUnlock };

  'onboarding-network': { onComplete: OnComplete; partial: Partial<OnboardingState> };
  'onboarding-source': { onComplete: OnComplete; partial: Partial<OnboardingState> };
  'onboarding-name': { onComplete: OnComplete; partial: Partial<OnboardingState> };
  'onboarding-seed': { onComplete: OnComplete; partial: Partial<OnboardingState> };
  'onboarding-birthday': { onComplete: OnComplete; partial: Partial<OnboardingState> };
  'onboarding-passphrase': { onComplete: OnComplete; partial: Partial<OnboardingState> };
  'onboarding-mnemonic-display': { onComplete: OnComplete; partial: Partial<OnboardingState> };
  'onboarding-initializing': { onComplete: OnComplete; partial: Partial<OnboardingState> };
};

export type RouteName = keyof Routes;
export type RouteParams<T extends RouteName> = Routes[T];

export type Route<T extends RouteName = RouteName> = Routes[T] extends undefined
  ? { name: T; params?: undefined }
  : { name: T; params: Routes[T] };

export interface Navigator {
  route: Route;
  stack: readonly Route[];
  push<T extends RouteName>(name: T, params: Routes[T]): void;
  replace<T extends RouteName>(name: T, params: Routes[T]): void;
  pop(): void;
  reset<T extends RouteName>(name: T, params: Routes[T]): void;
  canGoBack(): boolean;
}
