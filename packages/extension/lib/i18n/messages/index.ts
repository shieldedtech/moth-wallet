// The complete English catalog, merged from one file per UI area. This is the
// source of truth: the build emits `_locales/en/messages.json` from it (see
// wxt.config.ts) and `t()` falls back to it outside the extension runtime.
// Keys are `<area>_<camelCase>` (the `_locales` format allows [A-Za-z0-9_]).
// tests/i18n.test.ts guards key format and cross-file collisions.

import { accounts } from './accounts';
import { activity } from './activity';
import { addressBook } from './addressBook';
import { approval } from './approval';
import { common } from './common';
import { dapp } from './dapp';
import { dust } from './dust';
import { formatErrors } from './formatErrors';
import { home } from './home';
import { network } from './network';
import { receive } from './receive';
import { relay } from './relay';
import { send } from './send';
import { settings } from './settings';
import { setup } from './setup';
import { sites } from './sites';
import { status } from './status';
import { syncStatus } from './syncStatus';
import { syncView } from './syncView';
import { tokens } from './tokens';
import { unlock } from './unlock';
import { welcome } from './welcome';
import { words } from './words';

export const CATALOGS = {
  accounts,
  activity,
  addressBook,
  approval,
  common,
  dapp,
  dust,
  formatErrors,
  home,
  network,
  receive,
  relay,
  send,
  settings,
  setup,
  sites,
  status,
  syncStatus,
  syncView,
  tokens,
  unlock,
  welcome,
  words,
} as const;

export const MESSAGES = {
  ...accounts,
  ...activity,
  ...addressBook,
  ...approval,
  ...common,
  ...dapp,
  ...dust,
  ...formatErrors,
  ...home,
  ...network,
  ...receive,
  ...relay,
  ...send,
  ...settings,
  ...setup,
  ...sites,
  ...status,
  ...syncStatus,
  ...syncView,
  ...tokens,
  ...unlock,
  ...welcome,
  ...words,
} as const;

export type MessageKey = keyof typeof MESSAGES;
