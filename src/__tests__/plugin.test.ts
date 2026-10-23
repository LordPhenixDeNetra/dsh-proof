import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'
import { DEFAULT_MUTATING_SHELL, type Config } from '../types.js'

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    autoDetect: false,
    checks: [{ name: 'gate', command: 'node -e "process.exit(1)"', timeoutMs: 15_000 }],
    cwd: '',
    maxReruns: 1,
    outputChars: 2000,
    watchShell: false,
    mutatingShellPattern: DEFAULT_MUTATING_SHELL,
    includeSubagents: false,
    stopOnFirstFailure: true,
    ...overrides,
  }
}

interface Captured {
  tool?: ToolDefinition
  section?: { name: string; text: unknown }
  handlers: Map<string, (...args: any[]) => any>
}

function fakeContext(): { ctx: Context; captured: Captured } {
  const captured: Captured = { handlers: new Map() }
  const ctx = {
    effect(fn: () => unknown) {
      return fn()
    },
    tools: {
      register(definition: ToolDefinition) {
        captured.tool = definition
        return () => {}
      },
    },
    systemPrompt: {
      section(section: { name: string; text: unknown }) {
        captured.section = section
        return () => {}
      },
    },
    on(event: string, handler: (...args: any[]) => any) {
      captured.handlers.set(event, handler)
      return () => {}
    },
  } as unknown as Context
  return { ctx, captured }
}

function fakeAgent(cwd: string, id = 'session-1') {
  const steered: UserMessage[] = []
  const agent = {
    session: { id, header: { cwd } },
    steer(message: UserMessage) {
      steered.push(message)
    },
  } as unknown as Agent
  return { agent, steered }
}

test('apply registers a valid tool, a prompt section and both hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proof-plugin-'))
  try {
    const { ctx, captured } = fakeContext()
    apply(ctx, config({ checks: [{ name: 'typecheck', command: 'npm run typecheck', timeoutMs: 1000 }] }))

    assert.equal(captured.tool?.name, 'verify')
    assert.equal(captured.tool?.parameters.type, 'object')
    assert.equal(captured.section?.name, 'proof')
    assert.equal(typeof captured.handlers.get('session/event'), 'function')
    assert.equal(typeof captured.handlers.get('agent/turn-stopping'), 'function')

    const { agent } = fakeAgent(dir)
    const text = (captured.section?.text as (context: unknown) => string)({ agent })
    assert.match(text, /npm run typecheck/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a write followed by turn-stopping steers the agent with the real failing check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proof-plugin-'))
  try {
    const { ctx, captured } = fakeContext()
    apply(ctx, config())

    const { agent, steered } = fakeAgent(dir)
    captured.handlers.get('session/event')?.(
      { id: 'session-1', header: { cwd: dir } },
      { type: 'tool/call', data: { name: 'write', arguments: '{}' } },
    )
    await captured.handlers.get('agent/turn-stopping')?.({
      agent,
      turn: 1,
      signal: new AbortController().signal,
    })

    assert.equal(steered.length, 1)
    const block = steered[0]?.content[0]
    assert.equal(block?.type, 'text')
    assert.match(block?.type === 'text' ? block.text : '', /Proof gate/)
    assert.match(block?.type === 'text' ? block.text : '', /FAIL "gate"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the verify tool executes the configured check and returns its exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proof-plugin-'))
  try {
    const { ctx, captured } = fakeContext()
    apply(ctx, config())
    const { agent } = fakeAgent(dir)

    const value = (await captured.tool?.execute(
      {},
      { agent, signal: new AbortController().signal } as any,
    )) as {
      passed: boolean
      skipped: boolean
      cwd: string
      checks: Array<{ name: string; ok: boolean; exitCode: number }>
    }

    assert.equal(value.passed, false)
    assert.equal(value.skipped, false)
    assert.equal(value.checks[0]?.name, 'gate')
    assert.equal(value.checks[0]?.exitCode, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
