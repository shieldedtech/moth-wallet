export type TransactionResultStatus =
  | 'SUCCESS'
  | 'PARTIAL_SUCCESS'
  | 'FAILURE';

export interface TransactionResult {
  readonly hash: string;
  readonly status: TransactionResultStatus;
  readonly blockHash: string | null;
  readonly blockHeight: number | null;
  readonly contractAddress: string | null;
  readonly fees: { readonly paid: string; readonly estimated: string } | null;
}
