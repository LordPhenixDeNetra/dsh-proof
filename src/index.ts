/**
 * dsh-proof — a verification gate for DeepSeek Harness.
 *
 * After the agent edits files, the plugin runs the workspace's configured
 * checks (typecheck, lint, tests). When a check fails, the failure output is
 * steered back to the model before the turn can close, so "done" means the
 * checks actually passed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { ProofGate } from './gate.js'
import { exitLabel } from './runner.js'
import { DEFAULT_MUTATING_SHELL, type Config as ProofConfig } from './types.js'

/** Cordis plugin name; must match the patch row id. */
export const name = 'proof'

/** Services the plugin contributes to; the fiber stays pending until they exist. */
export const inject = ['tools', 'systemPrompt']

/** Configuration schema rendered by the DSH settings surface. */
export const Config: Schema<ProofConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  autoDetect: Schema.boolean().default(true),
  checks: Schema.array(
    Schema.object({
      name: Schema.string(),
      command: Schema.string(),
      timeoutMs: Schema.number().min(1000).max(3_600_000).default(120_000),
    }),
  ).default([]),
  cwd: Schema.string().default(''),
  maxReruns: Schema.number().min(0).max(10).default(2),
  outputChars: Schema.number().min(500).max(100_000).default(6000),
  watchShell: Schema.boolean().default(false),
  mutatingShellPattern: Schema.string().default(DEFAULT_MUTATING_SHELL),
  includeSubagents: Schema.boolean().default(false),
  stopOnFirstFailure: Schema.boolean().default(true),
})

/** Render a report for the model. */
function renderReport(value: {
  passed: boolean
  skipped: boolean
  reason?: string
  cwd: string
  checks: Array<{
    name: string
    command: string
    ok: boolean
    exitCode: number
    timedOut: boolean
    output: string
  }>
}): string {
  if (value.skipped) {
    return `Verification skipped: ${value.reason ?? 'no checks configured or detected.'}`
  }
  const lines = [
    `${value.passed ? 'PASS' : 'FAIL'} — ${value.checks.length} check(s) in ${value.cwd}`,
  ]
  for (const check of value.checks) {
    lines.push(`${check.ok ? '✓' : '✗'} ${check.name} (${check.timedOut ? 'timed out' : exitLabel(check.exitCode)})`)
    if (!check.ok && check.output) {
      lines.push('')
      lines.push(check.output)
      lines.push('')
    }
  }
  return lines.join('\n').trim()
}

/** Apply the plugin: one tool, one prompt section, two event hooks. */
export function apply(ctx: Context, config: ProofConfig): void {
  const gate = new ProofGate(config)

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'verify',
        description:
          'Run the workspace verification checks (typecheck, lint, tests) configured for this deployment. Use it after edits and before claiming a coding task is complete. It returns pass/fail plus the failing command output. It never modifies files.',
        parameters: {
          only: {
            type: 'string',
            description: 'Optional check name to run just that check (for example "test").',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              passed: { type: 'boolean' },
              skipped: { type: 'boolean' },
              reason: { type: 'string' },
              cwd: { type: 'string' },
              checks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    command: { type: 'string' },
                    ok: { type: 'boolean' },
                    exitCode: { type: 'number' },
                    timedOut: { type: 'boolean' },
                    output: { type: 'string' },
                  },
                },
              },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: renderReport(value as Parameters<typeof renderReport>[0]) },
          ],
        },
        timeoutMs: 300_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const cwd = gate.cwdFor(exec.agent)
          const report = await gate.run(cwd, exec.signal, args.only)
          return {
            passed: report.passed,
            skipped: report.skipped,
            ...(report.reason ? { reason: report.reason } : {}),
            cwd: report.cwd,
            checks: report.checks.map((check) => ({
              name: check.name,
              command: check.command,
              ok: check.ok,
              exitCode: check.exitCode,
              timedOut: check.timedOut,
              output: check.output,
            })),
          }
        },
      }),
    ),
  )

  ctx.systemPrompt.section({
    name: 'proof',
    order: 6550,
    text: (assemble) => gate.promptText(assemble.agent),
  })

  ctx.on('session/event', (session, event) => {
    gate.noteEvent(session, event)
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    await gate.onTurnStopping(payload)
  })
}
