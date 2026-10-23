/**
 * Command execution for verification checks.
 *
 * Commands are authored by the operator (plugin config) or detected from
 * package.json scripts. They run with the host's privileges, outside the DSH
 * file sandbox, exactly like a script the user typed in a terminal.
 */
import { spawn, type ChildProcess } from 'node:child_process'

/** Outcome of one shell command. */
export interface CommandOutcome {
  exitCode: number
  output: string
  timedOut: boolean
}

/** Injectable command runner, used by tests and by the plugin. */
export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxChars?: number,
) => Promise<CommandOutcome>

/** Keep the tail of streamed output, which is where failures usually are. */
function appendCapped(current: string, chunk: Buffer, cap: number): string {
  const next = current + chunk.toString('utf8')
  return next.length > cap * 2 ? next.slice(-cap * 2) : next
}

/** Head + tail truncation that preserves both the command context and the failure. */
export function truncateOutput(text: string, maxChars: number): string {
  const clean = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (clean.length <= maxChars) return clean
  const head = clean.slice(0, Math.min(1200, Math.floor(maxChars / 3)))
  const tail = clean.slice(-(maxChars - head.length - 32))
  return `${head}\n… [output truncated] …\n${tail}`
}

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {})
    } else {
      // The child is its own process-group leader (detached: true), so the
      // negative pid also reaches test workers it spawned.
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/**
 * Run one check command and capture a bounded combined output.
 * Never rejects: spawn failures become a non-zero outcome.
 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxChars = 6000,
): Promise<CommandOutcome> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ exitCode: -1, output: '[aborted before start]', timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    let killFallback: NodeJS.Timeout | undefined
    let child: ChildProcess

    const finish = (exitCode: number, note = '') => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killFallback) clearTimeout(killFallback)
      signal?.removeEventListener('abort', onAbort)
      const prefix = timedOut ? `[timed out after ${timeoutMs}ms]\n` : ''
      const combined = [prefix + note, stdout, stderr].filter(Boolean).join('\n')
      resolvePromise({
        exitCode,
        output: truncateOutput(combined, maxChars),
        timedOut,
      })
    }

    const onAbort = () => {
      if (settled) return
      if (child) killTree(child)
      finish(-1, '[aborted]')
    }

    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({
        exitCode: -1,
        output: truncateOutput(`failed to spawn: ${String(error)}`, maxChars),
        timedOut: false,
      })
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // A killed shell should close; keep a hard fallback for stuck trees.
      killFallback = setTimeout(() => finish(-1), 3000)
      killFallback.unref?.()
    }, timeoutMs)
    timer.unref?.()

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk, maxChars)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk, maxChars)
    })
    child.on('error', (error) => finish(-1, String(error)))
    child.on('close', (code) => finish(code ?? -1))
  })
}

/** Human label for an exit code. */
export function exitLabel(code: number): string {
  if (code === 0) return 'ok'
  if (code === -1) return 'failed to run'
  return `exit ${code}`
}
