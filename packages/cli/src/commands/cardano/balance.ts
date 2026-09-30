import { CardanoCommand, cardanoFlags } from '../../cardano-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { cnightUnit, formatCnight, readCardanoBalance } from '@shieldedtech/moth-wallet/cardano';

/** Lovelace are 6dp, the same way NIGHT is — render, do not round. */
function formatAda(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

export default class CardanoBalance extends CardanoCommand {
  static override description = 'Show ADA and cNIGHT held by this wallet on Cardano';

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CardanoBalance);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const config = await this.getCardanoConfig(flags.network, flags);
    const passphrase = await getPassphrase();

    const { balance, account } = await this.withCardano(
      walletName,
      passphrase,
      config,
      flags,
      async (session, acct) => ({ balance: await readCardanoBalance(session), account: acct }),
    );

    this.outputSuccess({
      wallet: walletName,
      account: account.label,
      accountId: account.id,
      cardanoNetwork: config.network,
      ada: formatAda(balance.lovelace),
      lovelace: balance.lovelace.toString(),
      cnight: formatCnight(balance.cnight),
      // The raw on-chain quantity, for anyone reconciling against an explorer:
      // Cardano publishes no decimals, so explorers show STARs.
      cnightStars: balance.cnight.toString(),
      cnightUtxos: balance.cnightUtxoCount,
      cnightUnit: cnightUnit(config),
    });
  }
}
