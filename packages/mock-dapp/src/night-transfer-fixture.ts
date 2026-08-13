import { bech32m } from '@scure/base';
import {
  CostModel,
  Intent,
  Transaction,
  UnshieldedOffer,
  nativeToken,
  type ProvingProvider,
} from '@midnight-ntwrk/ledger-v8';

export const NIGHT_TRANSFER_FIXTURE = {
  amountNight: '1',
  amountRaw: 1_000_000n,
  networkId: 'preprod',
  recipient: 'mn_addr_preprod1he0ty4u5vnmqdmvg85vgx9shxqh5snnvudszkr38ykqpkefu6xwsq30mjf',
} as const;

const FIXTURE_TTL_MS = 30 * 60_000;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function recipientOwner(): string {
  const decoded = bech32m.decodeToBytes(NIGHT_TRANSFER_FIXTURE.recipient);
  const expectedPrefix = `mn_addr_${NIGHT_TRANSFER_FIXTURE.networkId}`;
  if (decoded.prefix !== expectedPrefix) {
    throw new Error(`Fixture recipient must use the ${expectedPrefix} address prefix.`);
  }
  if (decoded.bytes.length !== 32) {
    throw new Error(`Fixture recipient decoded to ${decoded.bytes.length} bytes; expected 32.`);
  }
  return toHex(decoded.bytes);
}

const noProofsExpected: ProvingProvider = {
  async check() {
    throw new Error('The proof-free NIGHT transfer fixture unexpectedly requested a proof check.');
  },
  async prove() {
    throw new Error('The proof-free NIGHT transfer fixture unexpectedly requested proving.');
  },
};

export async function createUnbalancedNightTransfer(): Promise<{
  amountNight: string;
  amountRaw: bigint;
  bindingStage: 'unsealed';
  networkId: string;
  recipient: string;
  tokenType: string;
  transactionBytes: number;
  tx: string;
}> {
  const tokenType = nativeToken().raw;
  const intent = Intent.new(new Date(Date.now() + FIXTURE_TTL_MS));

  // NIGHT transfers are fallible ledger actions. Omitting inputs deliberately
  // leaves a 1 NIGHT deficit for balanceUnsealedTransaction to cover.
  intent.fallibleUnshieldedOffer = UnshieldedOffer.new(
    [],
    [{ owner: recipientOwner(), type: tokenType, value: NIGHT_TRANSFER_FIXTURE.amountRaw }],
    [],
  );

  const unproven = Transaction.fromParts(NIGHT_TRANSFER_FIXTURE.networkId, undefined, undefined, intent);

  // The connector accepts Proof + PreBinding. This intent contains no
  // proof-bearing actions, so prove() only advances its serialization marker
  // and never calls the provider above.
  const unbound = await unproven.prove(noProofsExpected, CostModel.initialCostModel());
  const serialized = unbound.serialize();

  return {
    ...NIGHT_TRANSFER_FIXTURE,
    bindingStage: 'unsealed',
    tokenType,
    transactionBytes: serialized.length,
    tx: toHex(serialized),
  };
}
