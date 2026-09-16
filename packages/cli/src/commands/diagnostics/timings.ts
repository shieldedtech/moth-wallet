import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { TimingEntry } from '@shieldedtech/moth-wallet';

/**
 * Read the phase timeline, the CLI's equivalent of the extension's debug.html.
 *
 * Recording is off by default and has to be turned on, because it writes to
 * disk on the sync hot path. The extension makes the same choice for the same
 * reason.
 */
export default class DiagnosticsTimings extends BaseCommand {
  static override description = 'Show, enable, disable or clear the phase-timings timeline';

  static override examples = [
    '<%= config.bin %> diagnostics timings on',
    '<%= config.bin %> balance',
    '<%= config.bin %> diagnostics timings',
    '<%= config.bin %> diagnostics timings clear',
  ];

  static override args = {
    action: Args.string({
      description: 'show (default), on, off, or clear',
      options: ['show', 'on', 'off', 'clear'],
      default: 'show',
      required: false,
    }),
  };

  static override flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DiagnosticsTimings);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    if (args.action === 'on' || args.action === 'off') {
      await this.timings.setEnabled(args.action === 'on');
      this.outputSuccess({
        enabled: args.action === 'on',
        path: '~/.moth/timings.json',
        message:
          args.action === 'on'
            ? 'Recording on. Run a command that syncs, then `diagnostics timings` to read it.'
            : 'Recording off, and the existing timeline was discarded.',
      });
      return;
    }

    if (args.action === 'clear') {
      await this.timings.clear();
      this.outputSuccess({ cleared: true });
      return;
    }

    const entries = await this.timings.list();
    if (this.outputFormat === 'json') {
      this.outputSuccess({ enabled: await this.timings.isEnabled(), entries });
      return;
    }

    if (entries.length === 0) {
      this.log(
        (await this.timings.isEnabled())
          ? 'Recording is on, but nothing has been recorded yet — run a command that syncs.'
          : 'Recording is off. Turn it on with `moth diagnostics timings on`.',
      );
      return;
    }

    // Deltas, not absolutes: "where did the wall clock go" is a question about
    // gaps between phases, and a column of epoch timestamps does not answer it.
    let previous: number | null = null;
    for (const e of entries as TimingEntry[]) {
      const delta = previous === null ? '' : formatDelta(e.at - previous);
      previous = e.at;
      const clock = new Date(e.at).toISOString().slice(11, 23);
      this.log(`${clock}  ${delta.padStart(8)}  ${e.source.padEnd(6)}  ${e.label}`);
    }
    const span = entries[entries.length - 1]!.at - entries[0]!.at;
    this.log(`\n${entries.length} entries over ${formatDelta(span)}.`);
  }
}

function formatDelta(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
