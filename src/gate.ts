/**
 * The verification gate state machine, independent of Cordis so it can be
 * tested without a host composition.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CheckSpec, Config, ResolvedCheck } from './types.js'
import { runCommand, type CommandRunner } from './runner.js'

/** Tools whose calls count as workspace edits. */
const EDIT_TOOL = /^(write|edit|str_replace_editor|apply_patch|multiedit|notebook_edit)$/i
/** Shell-like tools whose command may mutate the workspace. */
const SHELL_TOOL = /^(pwsh|bash|shell|terminal)$/i

/** One check outcome. */
export interface CheckResult extends ResolvedCheck {
  ok: boolean
  exitCode: number
  timedOut: boolean
  output: string
}

/** One verification run. */
export interface CheckReport {
  passed: boolean
  cwd: string
  checks: CheckResult[]
  skipped: boolean
  reason?: string
  aborted?: boolean
}

interface SessionState {
  dirty: boolean
  pending: boolean
  reruns: number
  last?: CheckReport
}

interface GateOptions {
  runner?: CommandRunner
  logger?: (message: string) => void
}

/** Detect the package manager from lockfiles, defaulting to npm. */
export function detectPackageManager(cwd: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun'
  return 'npm'
}

function packageCommand(manager: ReturnType<typeof detectPackageManager>, script: string): string {
  switch (manager) {
    case 'yarn':
      return `yarn ${script}`
    case 'pnpm':
      return `pnpm run ${script}`
    case 'bun':
      return `bun run ${script}`
    default:
      return `npm run ${script}`
  }
}

/**
 * Read package.json scripts and turn the conventional verification scripts
 * into checks. Auto-detection is intentionally conservative: only scripts a
 * project deliberately named are run.
 */
export function detectChecks(cwd: string): CheckSpec[] {
  const manifest = join(cwd, 'package.json')
  if (!existsSync(manifest)) return []
  let parsed: { scripts?: Record<string, unknown> }
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, unknown> }
  } catch {
    return []
  }
  const scripts = parsed.scripts ?? {}
  const manager = detectPackageManager(cwd)
  const ordered = ['typecheck', 'lint', 'test']
  const checks: CheckSpec[] = []
  for (const name of ordered) {
    if (typeof scripts[name] === 'string' && String(scripts[name]).trim()) {
      checks.push({ name, command: packageCommand(manager, name), timeoutMs: 120_000 })
    }
  }
  if (!checks.length && typeof scripts.check === 'string' && String(scripts.check).trim()) {
    checks.push({ name: 'check', command: packageCommand(manager, 'check'), timeoutMs: 120_000 })
  }
  return checks
}

function extractCommand(rawArguments: string | undefined): string | undefined {
  if (!rawArguments) return undefined
  try {
    const args = JSON.parse(rawArguments) as Record<string, unknown>
    for (const key of ['command', 'cmd', 'script']) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return value
    }
    const nested = args.args
    if (Array.isArray(nested)) {
      const commandIndex = nested.findIndex((entry) => entry === '-Command' || entry === '-c' || entry === '-lc')
      const next = commandIndex >= 0 ? nested[commandIndex + 1] : undefined
      if (typeof next === 'string' && next.trim()) return next
      const joined = nested.filter((entry): entry is string => typeof entry === 'string').join(' ')
      if (joined.trim()) return joined
    }
    if (typeof args.args === 'string' && args.args.trim()) return args.args
    return undefined
  } catch {
    return undefined
  }
}

/** Whether one tool call should mark the workspace dirty. */
export function isEditTool(
  name: string,
  rawArguments: string | undefined,
  watchShell: boolean,
  mutatingPattern: RegExp | undefined,
): boolean {
  if (EDIT_TOOL.test(name)) return true
  if (!watchShell || !mutatingPattern) return false
  if (!SHELL_TOOL.test(name)) return false
  const command = extractCommand(rawArguments)
  return command ? mutatingPattern.test(command) : false
}

/** The gate: tracks edit activity per session and enforces checks at turn end. */
export class ProofGate {
  private readonly states = new Map<string, SessionState>()
  private readonly detectCache = new Map<string, { mtimeMs: number; checks: CheckSpec[] }>()
  private readonly mutatingPattern: RegExp | undefined
  private readonly runner: CommandRunner
  private readonly logger: (message: string) => void

  constructor(
    private readonly config: Config,
    options: GateOptions = {},
  ) {
    this.runner = options.runner ?? runCommand
    this.logger = options.logger ?? ((message) => console.warn(`[dsh-proof] ${message}`))
    if (config.watchShell && config.mutatingShellPattern) {
      try {
        this.mutatingPattern = new RegExp(config.mutatingShellPattern)
      } catch (error) {
        this.logger(`invalid mutatingShellPattern, shell tracking disabled: ${String(error)}`)
        this.mutatingPattern = undefined
      }
    }
  }

  /** Reset per-turn state at turn start and record edits as they occur. */
  noteEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start') {
      this.states.set(session.id, { dirty: false, pending: false, reruns: 0 })
      return
    }
    if (event.type !== 'tool/call') return
    const name = event.data.name
    if (!isEditTool(name, event.data.arguments, this.config.watchShell, this.mutatingPattern)) return
    const state = this.states.get(session.id) ?? { dirty: false, pending: false, reruns: 0 }
    state.dirty = true
    this.states.set(session.id, state)
  }

  /** Test seam: record an edit without a session event. */
  noteEdit(sessionId: string): void {
    const state = this.states.get(sessionId) ?? { dirty: false, pending: false, reruns: 0 }
    state.dirty = true
    this.states.set(sessionId, state)
  }

  /** Resolve the working directory for an agent, honoring the override. */
  cwdFor(agent?: Agent): string {
    const base = agent?.session.header.cwd ?? process.cwd()
    if (!this.config.cwd) return base
    return isAbsolute(this.config.cwd) ? this.config.cwd : resolve(base, this.config.cwd)
  }

  /** Explicit checks win; otherwise auto-detect from package.json. */
  resolveChecks(cwd: string, only?: string): ResolvedCheck[] {
    const explicit = (this.config.checks ?? []).filter(
      (check) => check && check.name?.trim() && check.command?.trim(),
    )
    let checks: CheckSpec[]
    if (explicit.length) {
      checks = explicit
    } else if (this.config.autoDetect) {
      checks = this.detectOnce(cwd)
    } else {
      checks = []
    }
    const resolved = checks.map((check) => ({
      ...check,
      timeoutMs: check.timeoutMs ?? 120_000,
    }))
    if (!only) return resolved
    const needle = only.trim().toLowerCase()
    return resolved.filter((check) => check.name.toLowerCase() === needle)
  }

  /** Auto-detection cached by package.json mtime. */
  private detectOnce(cwd: string): CheckSpec[] {
    const manifest = join(cwd, 'package.json')
    let mtimeMs = 0
    try {
      mtimeMs = statSync(manifest).mtimeMs
    } catch {
      this.detectCache.delete(cwd)
      return []
    }
    const cached = this.detectCache.get(cwd)
    if (cached && cached.mtimeMs === mtimeMs) return cached.checks
    const checks = detectChecks(cwd)
    this.detectCache.set(cwd, { mtimeMs, checks })
    return checks
  }

  /** Run the resolved checks sequentially. */
  async run(cwd: string, signal?: AbortSignal, only?: string): Promise<CheckReport> {
    const checks = this.resolveChecks(cwd, only)
    if (!checks.length) {
      return {
        passed: false,
        cwd,
        checks: [],
        skipped: true,
        reason: only
          ? `No configured or detected check named "${only}".`
          : 'No verification checks configured or detected for this workspace.',
      }
    }

    const results: CheckResult[] = []
    for (const check of checks) {
      if (signal?.aborted) break
      const outcome = await this.runner(check.command, cwd, check.timeoutMs, signal, this.config.outputChars)
      results.push({
        ...check,
        ok: outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        output: outcome.output,
      })
      if (!results[results.length - 1]?.ok && this.config.stopOnFirstFailure) break
    }

    const aborted = signal?.aborted ?? false
    return {
      passed: !aborted && results.length > 0 && results.every((result) => result.ok),
      cwd,
      checks: results,
      skipped: false,
      aborted,
    }
  }

  /**
   * Turn-stop hook: run checks when the agent edited files (or a previous
   * verification failed) and steer it back to work on failure.
   */
  async onTurnStopping(payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> {
    if (!this.config.enabled) return
    const { agent, signal } = payload
    const header = agent.session.header
    if (!this.config.includeSubagents && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) {
      return
    }

    const sessionId = agent.session.id
    const state = this.states.get(sessionId)
    if (!state || (!state.dirty && !state.pending)) return
    if (signal.aborted) return
    // A failed verification already used its correction budget: let the turn end.
    if (state.pending && state.reruns >= this.config.maxReruns) {
      state.dirty = false
      state.pending = false
      this.logger(`verification budget exhausted for ${sessionId} (${state.reruns} reruns)`)
      return
    }

    const cwd = this.cwdFor(agent)
    try {
      if (!statSync(cwd).isDirectory()) {
        this.logger(`workspace is not a directory: ${cwd}`)
        state.dirty = false
        return
      }
    } catch (error) {
      this.logger(`cannot inspect workspace ${cwd}: ${String(error)}`)
      state.dirty = false
      return
    }

    if (!this.resolveChecks(cwd).length) {
      state.dirty = false
      state.pending = false
      return
    }

    state.dirty = false
    const report = await this.run(cwd, signal)
    if (signal.aborted) return
    state.last = report

    if (report.skipped || report.passed) {
      state.pending = false
      return
    }

    if (state.reruns >= this.config.maxReruns) {
      state.pending = false
      this.logger(`verification still failing for ${sessionId}; allowing the turn to end`)
      return
    }

    state.reruns += 1
    state.pending = true
    try {
      agent.steer(this.buildSteerMessage(report))
    } catch (error) {
      state.pending = false
      this.logger(`failed to steer agent after verification failure: ${String(error)}`)
    }
  }

  /** The synthetic user-role message that sends failures back to the model. */
  buildSteerMessage(report: CheckReport): UserMessage {
    const failed = report.checks.filter((check) => !check.ok)
    const summary = `Verification failed: ${failed.map((check) => check.name).join(', ') || 'checks'}`
    const lines: string[] = [
      '[Proof gate] The harness ran the workspace verification checks after your edits and they failed.',
      'Do not report the task as complete. Fix the failures below, then finish again.',
      '',
      `Workspace: ${report.cwd}`,
      '',
    ]
    for (const check of failed) {
      lines.push(`FAIL "${check.name}" (${check.timedOut ? 'timed out' : `exit ${check.exitCode}`}):`)
      lines.push('```text')
      lines.push(check.output || '(no output)')
      lines.push('```')
      lines.push('')
    }
    lines.push(
      'If a failure is unrelated to your change and cannot be fixed here, say so explicitly, explain why, and stop.',
    )
    return createUserMessage({
      content: [{ type: 'text', text: lines.join('\n') }],
      source: { kind: 'proof', form: 'notice', summary: summary.slice(0, 120) },
    })
  }

  /** System-prompt contribution describing the active check set. */
  promptText(agent?: Agent): string {
    if (!this.config.enabled) return ''
    const cwd = this.cwdFor(agent)
    const checks = this.resolveChecks(cwd)
    if (!checks.length) return ''
    const lines = [
      '## Verification gate (dsh-proof)',
      'After file edits, the harness runs these checks before the turn may end:',
      ...checks.map((check) => `- \`${check.name}\`: \`${check.command}\``),
      'A failure is sent back to you with the command output, and you get another step to fix it. Use the `verify` tool to run the checks yourself at any time. Never claim completion while a check fails.',
    ]
    return lines.join('\n')
  }

  /** Last report for diagnostics/tests. */
  lastReport(sessionId: string): CheckReport | undefined {
    return this.states.get(sessionId)?.last
  }
}
