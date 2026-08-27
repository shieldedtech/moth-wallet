import { canonicalNetworkId } from '@shieldedtech/moth-wallet';
import { BaseCommand } from '../base-command.js';

export default class Tui extends BaseCommand {
  static override description = 'Launch interactive terminal dashboard';

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Tui);

    const walletName = await this.resolveWalletName(flags).catch(() => 'none');
    // The TUI is handed the flag value directly rather than a resolved config,
    // so a renamed id is resolved here instead.
    const networkId = canonicalNetworkId(flags.network);

    // Dynamic imports — TUI, React, and Ink loaded only when this command runs
    const { render } = await import('ink');
    const { createElement } = await import('react');
    const tui = await import(/* webpackIgnore: true */ '@shieldedtech/moth-tui') as any;

    render(createElement(tui.App, { walletName, networkId }));
  }
}
