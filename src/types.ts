/**
 * Public configuration and the message-source identity of a verification
 * steering message.
 */
import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Synthetic context authored by the proof gate. `notice` lets clients
     * present it as a one-line event instead of a human prompt.
     */
    proof: {
      kind: 'proof'
      form: 'notice'
      summary: string
    }
  }
}

/** One configured verification command. */
export interface CheckSpec {
  /** Stable, human-readable name (`typecheck`, `test`, …). */
  name: string
  /** Shell command run from the workspace directory. */
  command: string
  /** Per-check timeout in milliseconds. */
  timeoutMs?: number
}

/** Plugin configuration. */
export interface Config {
  /** Master switch. */
  enabled: boolean
  /** Detect package.json scripts when `checks` is empty. */
  autoDetect: boolean
  /** Explicit checks; when non-empty, auto-detection is disabled. */
  checks: CheckSpec[]
  /** Working directory override; relative paths resolve from the session cwd. */
  cwd: string
  /** Maximum failed verification cycles that may steer the agent per turn. */
  maxReruns: number
  /** Maximum characters of check output sent back to the model. */
  outputChars: number
  /** Treat mutating shell commands as edits too. */
  watchShell: boolean
  /** Regex identifying mutating shell commands (when `watchShell` is on). */
  mutatingShellPattern: string
  /** Also gate subagent sessions. */
  includeSubagents: boolean
  /** Stop after the first failing check. */
  stopOnFirstFailure: boolean
}

/** Default shell-mutation heuristic: file mutations, git rewrites, package installs. */
export const DEFAULT_MUTATING_SHELL = String.raw`(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|rmdir|touch|sed|perl|tee|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)\b|git\s+(?:apply|checkout|restore|reset|clean|stash|merge|rebase)\b|(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|update)\b`

/** Fully resolved check with a numeric timeout. */
export interface ResolvedCheck extends CheckSpec {
  timeoutMs: number
}
