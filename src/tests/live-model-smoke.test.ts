import { describe, expect, test } from 'bun:test'
import {
  type CommandResult,
  classifySmokeResult,
  isBlockingSmokeStatus,
  parseAnthropicModels,
  sanitizeDiagnostic,
} from '../../scripts/live-model-smoke'

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  }
}

describe('live model discovery', () => {
  test('returns sorted, unique Anthropic model IDs only', () => {
    expect(
      parseAnthropicModels(`
        openai/gpt-5
        anthropic/claude-opus-5
        anthropic/claude-haiku-4-5
        anthropic/claude-opus-5
        malformed anthropic/claude
      `),
    ).toEqual(['anthropic/claude-haiku-4-5', 'anthropic/claude-opus-5'])
  })
})

describe('live model result classification', () => {
  test('passes only when the sentinel is present', () => {
    expect(
      classifySmokeResult(result({ exitCode: 0, stdout: 'MODEL_SMOKE_OK' })),
    ).toBe('passed')
    expect(classifySmokeResult(result({ exitCode: 0, stdout: 'hello' }))).toBe(
      'unexpected_output',
    )
  })

  test('classifies unsupported models', () => {
    expect(
      classifySmokeResult(result({ stderr: 'invalid model: claude-future' })),
    ).toBe('unsupported')
  })

  test('classifies subscription blocks', () => {
    expect(
      classifySmokeResult(
        result({ stderr: "You're out of extra usage. Add more." }),
      ),
    ).toBe('subscription_blocked')
  })

  test('classifies fast models that require usage credits', () => {
    expect(
      classifySmokeResult(
        result({ stderr: 'Usage credits are required for fast mode.' }),
      ),
    ).toBe('usage_credits_required')
  })

  test('classifies rate limits', () => {
    expect(classifySmokeResult(result({ stderr: 'HTTP 429' }))).toBe(
      'rate_limited',
    )
  })

  test('classifies authentication failures', () => {
    expect(
      classifySmokeResult(result({ stderr: 'HTTP 401 Unauthorized' })),
    ).toBe('authentication_failed')
  })

  test('classifies provider failures and timeouts', () => {
    expect(classifySmokeResult(result({ stderr: 'HTTP 529 overloaded' }))).toBe(
      'server_error',
    )
    expect(classifySmokeResult(result({ timedOut: true }))).toBe('timed_out')
  })

  test('treats paid fast-mode restrictions as non-blocking', () => {
    expect(isBlockingSmokeStatus('passed')).toBe(false)
    expect(isBlockingSmokeStatus('usage_credits_required')).toBe(false)
    expect(isBlockingSmokeStatus('unsupported')).toBe(true)
  })
})

describe('live model diagnostic sanitization', () => {
  test('removes ANSI escapes and common credential forms', () => {
    const diagnostic = sanitizeDiagnostic(
      '\u001b[31mBearer secret-token sk-ant-secret access_token=abc refresh: def\u001b[0m',
    )

    expect(diagnostic).not.toContain('secret-token')
    expect(diagnostic).not.toContain('sk-ant-secret')
    expect(diagnostic).not.toContain('abc')
    expect(diagnostic).not.toContain('def')
    expect(diagnostic).not.toContain('\u001b')
  })
})
