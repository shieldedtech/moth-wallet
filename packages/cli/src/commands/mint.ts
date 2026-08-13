import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command.js';
import { getPassphrase } from '../adapters/passphrase.js';
import {
  deployFungibleToken,
  mintFungibleToken,
  startWalletSync,
  describeProver,
  resolveProverConfig,
} from '@shieldedtech/moth-wallet';

export default class Mint extends BaseCommand {
  static override description = [
    'Mint fungible tokens using the bundled moth-ft token contract.',
    '',
    'Provide --address to mint on an already-deployed moth-ft contract, or omit it',
    'to auto-deploy a fresh token contract and mint against it in one go.',
    'Tokens are minted to --recipient (a bech32m address) or, by default, to your',
    "own wallet's address for the selected token type (shielded unless --unshielded).",
  ].join('\n');

  static override args = {
    amount: Args.string({ description: 'Amount to mint (raw integer units)', required: true }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    address: Flags.string({
      description: 'Deployed moth-ft contract address. Omit to auto-deploy a new token contract.',
    }),
    recipient: Flags.string({
      description: "Recipient bech32m address. Defaults to your own wallet address for the token type.",
    }),
    unshielded: Flags.boolean({
      description: 'Mint an unshielded (transparent) token instead of a shielded one.',
      default: false,
    }),
    yes: Flags.boolean({ char: 'y', description: 'Skip confirmation prompt', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Mint);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const amount = BigInt(await this.promptIfMissing(args.amount, 'Amount to mint'));
    const shielded = !flags.unshielded;

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Default the recipient to the active wallet's own address for the token type.
    const selfRecipient = shielded
      ? wallet.addresses.zswap.bech32m[network.id]
      : wallet.addresses.nightExternal.bech32m[network.id];
    const recipient = flags.recipient ?? selfRecipient;
    if (!recipient) {
      throw new Error('Could not determine a recipient address — pass --recipient explicitly.');
    }

    const timeoutMs = flags.timeout ? flags.timeout * 1000 : 300_000;

    await this.confirmTransaction({
      'Operation': flags.address ? 'Mint tokens' : 'Deploy FT contract + mint tokens',
      'Contract': flags.address ?? '(auto-deploy new moth-ft contract)',
      'Amount': amount.toString(),
      'Token type': shielded ? 'shielded' : 'unshielded',
      'Recipient': recipient,
      'Network': network.id,
      'Wallet': walletName,
      'Prover': describeProver(resolveProverConfig(network)),
    }, flags);

    // Mint requires a synced wallet for transaction balancing (DUST fees + signing).
    process.stderr.write('Syncing wallet before mint...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg) => {
      this.log_verbose(msg);
      if (msg.includes('syncing') || msg.includes('synced')) {
        process.stderr.write(`\r  ${msg}${''.padEnd(20)}`);
      }
    }, walletName);
    process.stderr.write('\n');

    try {
      let contractAddress = flags.address;

      if (!contractAddress) {
        process.stderr.write('Deploying fungible token contract...\n');
        const deployed = await deployFungibleToken({
          walletKeys: wallet.walletKeys,
          network,
          syncedWallet,
          timeoutMs,
          onProgress: (stage) => process.stderr.write(`Deploy: ${stage}\n`),
        });
        if (!deployed.contractAddress) {
          throw new Error('Deploy did not return a contract address');
        }
        contractAddress = deployed.contractAddress;
        this.log_verbose(`Deployed moth-ft contract: ${contractAddress}`);
      }

      process.stderr.write('Minting...\n');
      const result = await mintFungibleToken({
        contractAddress,
        recipientAddress: recipient,
        amount,
        shielded,
        keys: wallet.keys,
        walletKeys: wallet.walletKeys,
        network,
        syncedWallet,
        timeoutMs,
      });

      this.outputSuccess({
        status: result.status,
        txHash: result.hash,
        contractAddress,
        amount: amount.toString(),
        tokenType: shielded ? 'shielded' : 'unshielded',
        recipient,
        blockHash: result.blockHash,
        blockHeight: result.blockHeight,
        fees: result.fees,
      });
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}
