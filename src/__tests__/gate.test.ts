import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ProofGate, detectChecks, detectPackageManager, isEditTool } from '../gate.js'
import { runCommand, truncateOutput } from '../runner.js'
import { DEFAULT_MUTATING_SHELL, type Config } from '../types.js'

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    autoDetect: false,
    checks: [{ name: 'unit', command: 'fake', timeoutMs: 1000 }],
    cwd: '',
    maxReruns: 2,
    outputChars: 2000,
    watchShell: false,
    mutatingShellPattern: DEFAULT_MUTATING_SHELL,
    includeSubagents: false,
    stopOnFirstFailure: true,
    ...overrides,
  }
}

function fakeAgent(cwd: string | undefined, id = 'session-1', header: Record<string, unknown> = {}) {
  const steered: UserMessage[] = []
  const agent = {
    session: { id, header: { ...(cwd ? { cwd } : {}), ...header } },
    steer(message: UserMessage) {
      steered.push(message)
    },
  } as unknown as Agent
  return { agent, steered }
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proof-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'node --test' } }),
  )
  return dir
}

test('detects conventional package.json scripts in priority order', () => {
  const dir = workspace()
  try {
    const checks = detectChecks(dir)
    assert.deepEqual(
      checks.map((check) => check.name),
      ['typecheck', 'lint', 'test'],
    )
    assert.match(checks[0]?.command ?? '', /(npm|pnpm|yarn|bun) (run )?typecheck/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('falls back to npm when the lockfile manager is unavailable', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    assert.equal(detectPackageManager(dir, (name) => name === 'npm'), 'npm')
    assert.equal(detectPackageManager(dir, (name) => name === 'pnpm' || name === 'npm'), 'pnpm')
    assert.match(
      detectChecks(dir, (name) => name === 'npm')[0]?.command ?? '',
      /^npm run typecheck$/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('strips terminal colour codes and normalizes newlines', () => {
  assert.equal(truncateOutput('\u001b[31mred\u001b[0m\r\nline', 100), 'red\nline')
  assert.equal(truncateOutput('short', 100), 'short')
})

test('recognises edit tools and optionally mutating shells', () => {
  assert.equal(isEditTool('write', undefined, false, undefined), true)
  assert.equal(isEditTool('edit', undefined, false, undefined), true)
  assert.equal(isEditTool('read', undefined, false, undefined), false)
  assert.equal(isEditTool('pwsh', JSON.stringify({ command: 'rm -rf build' }), false, /rm/), false)
  assert.equal(isEditTool('pwsh', JSON.stringify({ command: 'rm -rf build' }), true, /rm/), true)
  assert.equal(isEditTool('pwsh', JSON.stringify({ command: 'Get-ChildItem' }), true, /rm/), false)
})

test('runs a real command and reports its exit code and output', async () => {
  const outcome = await runCommand(
    'node -e "console.log(\'checked\'); process.exit(3)"',
    process.cwd(),
    15_000,
    undefined,
    2000,
  )
  assert.equal(outcome.exitCode, 3)
  assert.match(outcome.output, /checked/)
  assert.equal(outcome.timedOut, false)
})

test('steers the agent with failure output, then clears pending state on success', async () => {
  const dir = workspace()
  try {
    const { agent, steered } = fakeAgent(dir)
    let call = 0
    const gate = new ProofGate(config({ checks: [{ name: 'test', command: 'fake', timeoutMs: 1000 }] }), {
      runner: async () => {
        call += 1
        return call === 1
          ? { exitCode: 1, output: 'expected 2 but got 3', timedOut: false }
          : { exitCode: 0, output: 'ok', timedOut: false }
      },
      logger: () => {},
    })

    gate.noteEdit('session-1')
    await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })

    assert.equal(steered.length, 1)
    assert.match(steered[0]?.content[0]?.type === 'text' ? steered[0]?.content[0]?.text : '', /expected 2 but got 3/)
    assert.match(steered[0]?.content[0]?.type === 'text' ? steered[0]?.content[0]?.text : '', /Do not report the task as complete/)
    assert.match(steered[0]?.content[0]?.type === 'text' ? steered[0]?.content[0]?.text : '', /untrusted diagnostic data/)

    await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(steered.length, 1)
    assert.equal(gate.lastReport('session-1')?.passed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stops steering after maxReruns', async () => {
  const dir = workspace()
  try {
    const { agent, steered } = fakeAgent(dir)
    const gate = new ProofGate(config({ maxReruns: 1, checks: [{ name: 'test', command: 'fake', timeoutMs: 1000 }] }), {
      runner: async () => ({ exitCode: 1, output: 'still broken', timedOut: false }),
      logger: () => {},
    })

    gate.noteEdit('session-1')
    await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(steered.length, 1)

    await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(steered.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maxReruns 0 still verifies but never steers', async () => {
  const dir = workspace()
  try {
    const { agent, steered } = fakeAgent(dir)
    let runs = 0
    const gate = new ProofGate(config({ maxReruns: 0, checks: [{ name: 'test', command: 'fake', timeoutMs: 1000 }] }), {
      runner: async () => {
        runs += 1
        return { exitCode: 1, output: 'broken', timedOut: false }
      },
      logger: () => {},
    })

    gate.noteEdit('session-1')
    await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(runs, 1)
    assert.equal(steered.length, 0)
    assert.equal(gate.lastReport('session-1')?.passed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skips subagent sessions unless includeSubagents is enabled', async () => {
  const dir = workspace()
  try {
    let runs = 0
    const gate = new ProofGate(config(), {
      runner: async () => {
        runs += 1
        return { exitCode: 1, output: 'broken', timedOut: false }
      },
      logger: () => {},
    })
    const { agent, steered } = fakeAgent(dir, 'session-1', { origin: 'subagent', delegationDepth: 1 })
    gate.noteEdit('session-1')
    await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(runs, 0)
    assert.equal(steered.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skips a session without a working directory', async () => {
  let runs = 0
  const gate = new ProofGate(config(), {
    runner: async () => {
      runs += 1
      return { exitCode: 1, output: 'broken', timedOut: false }
    },
    logger: () => {},
  })
  const { agent, steered } = fakeAgent(undefined)
  gate.noteEdit('session-1')
  await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(runs, 0)
  assert.equal(steered.length, 0)
})

test('forgetting a session drops its pending edit state', async () => {
  const dir = workspace()
  try {
    let runs = 0
    const gate = new ProofGate(config(), {
      runner: async () => {
        runs += 1
        return { exitCode: 0, output: '', timedOut: false }
      },
      logger: () => {},
    })
    const { agent } = fakeAgent(dir)
    gate.noteEdit('session-1')
    gate.forget('session-1')
    await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(runs, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a timed-out command is never a passing check', async () => {
  const dir = workspace()
  try {
    const gate = new ProofGate(config({ checks: [{ name: 'test', command: 'fake', timeoutMs: 1000 }] }), {
      runner: async () => ({ exitCode: 0, output: 'timed out', timedOut: true }),
      logger: () => {},
    })
    const report = await gate.run(dir)
    assert.equal(report.passed, false)
    assert.equal(report.checks[0]?.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('does nothing without edits and exposes active checks in the prompt', async () => {
  const dir = workspace()
  try {
    const { agent, steered } = fakeAgent(dir)
    const gate = new ProofGate(config({ checks: [{ name: 'test', command: 'npm test', timeoutMs: 1000 }] }), {
      runner: async () => ({ exitCode: 0, output: '', timedOut: false }),
      logger: () => {},
    })

    await gate.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(steered.length, 0)

    const prompt = gate.promptText(agent)
    assert.match(prompt, /Verification gate/)
    assert.match(prompt, /npm test/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
