import { stat } from 'node:fs/promises';
import { InvalidInputError } from '../types/errors.js';

export type WitnessProvider = Record<string, (...args: unknown[]) => unknown>;

export async function loadWitnessProvider(witnessPath: string): Promise<WitnessProvider> {
  // Verify file exists
  try {
    const s = await stat(witnessPath);
    if (!s.isFile()) {
      throw new InvalidInputError(`Not a file: ${witnessPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InvalidInputError(`Witness file not found: ${witnessPath}`);
    }
    throw err;
  }

  // Dynamic import
  const moduleUrl = new URL(`file://${witnessPath}`);
  const module = await import(moduleUrl.href) as Record<string, unknown>;

  // Check for makeWitnesses export
  const makeWitnesses = module.makeWitnesses ?? (module.default as Record<string, unknown>)?.makeWitnesses;
  if (typeof makeWitnesses !== 'function') {
    throw new InvalidInputError(
      `Witness file ${witnessPath} must export a 'makeWitnesses' function`,
    );
  }

  return module as WitnessProvider;
}
