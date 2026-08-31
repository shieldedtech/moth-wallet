// Assembly of the moth-wallet MCP server: metadata, instructions, and
// tool registration. Pure — no process, transport, or signal concerns
// (those live in commands/mcp.ts).

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {registerReadTools, registerSpendTools, type McpToolDeps, type SpendToolConfig} from './tools.js';

export interface McpServerDeps extends McpToolDeps {
  /** CLI version string, reported in the MCP handshake. */
  readonly version: string;
  /** Present only when the consent gate passed — registers spend tools. */
  readonly spend?: SpendToolConfig;
}

export function buildMcpServer(deps: McpServerDeps): McpServer {
  const rt = deps.runtime;
  const spendNote = deps.spend
    ? 'Spend tools (transfer_tokens, estimate_transfer_fee, dust_register, dust_deregister) are enabled: ' +
      'every spend is auto-approved without human confirmation, audited to ~/.moth/daemon-audit.log, and ' +
      'NIGHT transfers are capped per transaction by the operator. Confirm intent carefully before spending.' +
      (deps.spend.allowBalancing
        ? ' balance_transaction (balance/prove/sign externally-built transactions) and submit_transaction ' +
          '(submit a pre-built FinalizedTransaction) are also enabled — they move value the cap cannot see; ' +
          'only use them on transactions the user explicitly asked to pay or send.'
        : '')
    : 'This server is read-only: spend tools are not registered. The operator must restart it with ' +
      '--auto-approve, MOTH_DAEMON_AUTO_APPROVE=1, and --max-spend to enable spending.';

  const server = new McpServer(
    {name: 'moth-wallet', version: deps.version},
    {
      instructions:
        `Moth wallet "${rt.walletName}" on the Midnight ${rt.network.id} network. ` +
        'All token amounts cross this interface as decimal strings in the smallest unit ' +
        '(STARS for NIGHT at 10^6 per NIGHT, SPECK for DUST); JSON never carries numbers for amounts. ' +
        'The wallet syncs in the background after startup: call wait_for_sync before treating balances ' +
        'or activity as authoritative, and check the `synced`/`everSynced` fields returned by read tools. ' +
        spendNote,
    },
  );

  registerReadTools(server, deps);
  if (deps.spend) registerSpendTools(server, deps, deps.spend);
  return server;
}
