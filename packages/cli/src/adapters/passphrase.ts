import { createInterface } from 'node:readline';
import { WalletError } from '@shieldedtech/moth-wallet';

const ENV_VAR = 'MOTH_PASSPHRASE';

export async function getPassphrase(prompt = 'Passphrase: '): Promise<string> {
  // CI/non-interactive: use environment variable (FR-006)
  // NEVER accept passphrase as CLI argument (SR-001)
  const envPassphrase = process.env[ENV_VAR];
  if (envPassphrase) return envPassphrase;

  // Interactive: prompt from terminal with hidden input
  if (!process.stdin.isTTY) {
    throw new WalletError(
      'WALLET_ERROR',
      `No passphrase provided. Set ${ENV_VAR} environment variable for non-interactive use.`,
    );
  }

  return promptPassphraseHidden(prompt);
}

function promptPassphraseHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write prompt to stderr (keep stdout clean for JSON output)
    process.stderr.write(prompt);

    // Enable raw mode to read characters one at a time without echo
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    let input = '';

    const onData = (char: string) => {
      const c = char.toString();

      if (c === '\n' || c === '\r' || c === '\u0004') {
        // Enter or Ctrl+D — done
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stderr.write('\n');

        if (!input) {
          reject(new WalletError('WALLET_ERROR', 'Passphrase cannot be empty'));
          return;
        }
        resolve(input);
      } else if (c === '\u0003') {
        // Ctrl+C — abort
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stderr.write('\n');
        process.exit(1);
      } else if (c === '\u007f' || c === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stderr.write('\b \b'); // Erase the asterisk
        }
      } else if (c.charCodeAt(0) >= 32) {
        // Printable character
        input += c;
        process.stderr.write('*'); // Show asterisk for each character
      }
    };

    process.stdin.on('data', onData);
  });
}
