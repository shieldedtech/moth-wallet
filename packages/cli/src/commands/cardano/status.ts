import { CardanoCommand, cardanoFlags } from '../../cardano-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { formatCnight, readCardanoDustStatus } from '@shieldedtech/moth-wallet/cardano';

export default class CardanoStatus extends CardanoCommand {
  static override description = 'Show cNIGHT holdings and DUST designation status';

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CardanoStatus);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const config = await this.getCardanoConfig(flags.network, flags);
    const passphrase = await getPassphrase();

    const ownDustAddress = await this.getOwnDustAddress(walletName, passphrase, flags.network);
    const { status, account } = await this.withCardano(
      walletName,
      passphrase,
      config,
      flags,
      async (session, acct) => ({
        status: await readCardanoDustStatus(session, network.indexerUrl),
        account: acct,
      }),
    );

    this.outputSuccess({
      wallet: walletName,
      account: account.label,
      accountId: account.id,
      cardanoNetwork: status.network,
      midnightNetwork: network.id,
      address: status.addresses.address,
      rewardAddress: status.addresses.rewardAddress,
      cnight: formatCnight(status.balance.cnight),
      cnightStars: status.balance.cnight.toString(),
      cnightUtxos: status.balance.cnightUtxoCount,
      lovelace: status.balance.lovelace.toString(),
      registered: status.registered,
      registeredDustAddress: status.dustAddress,
      // Whether the registration points at THIS wallet. A registration made
      // from another Midnight wallet is still a valid registration, and reading
      // `registered: true` alone would hide that the DUST goes elsewhere.
      registeredToThisWallet: status.dustAddress === ownDustAddress,
      // Valid on Cardano, unmatchable by Midnight: the registration looks
      // healthy and generates nothing. Reported as its own field so a script
      // can act on it rather than diffing address lengths.
      legacyDustAddress: status.legacyDustAddress,
      registrationUtxo: status.registrationUtxo
        ? `${status.registrationUtxo.txHash}#${status.registrationUtxo.outputIndex}`
        : null,
      // Null while the Midnight side has not yet observed the Cardano
      // registration. That is the normal state for the first few minutes.
      dustGeneration: status.generation,
      mappingValidator: status.mappingValidatorAddress,
    });
  }
}
