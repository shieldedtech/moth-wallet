export type WalletErrorCategory =
  | 'NETWORK_ERROR'
  | 'WALLET_ERROR'
  | 'PROOF_ERROR'
  | 'TIMEOUT'
  | 'INVALID_INPUT';

export class WalletError extends Error {
  readonly category: WalletErrorCategory;

  constructor(category: WalletErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WalletError';
    this.category = category;
  }
}

export class NetworkError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('NETWORK_ERROR', message, cause);
    this.name = 'NetworkError';
  }
}

export class ProofError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('PROOF_ERROR', message, cause);
    this.name = 'ProofError';
  }
}

export class TimeoutError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('TIMEOUT', message, cause);
    this.name = 'TimeoutError';
  }
}

export class InvalidInputError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('INVALID_INPUT', message, cause);
    this.name = 'InvalidInputError';
  }
}
