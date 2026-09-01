const SENTINEL = 'MODEL_SMOKE_OK'

export type SmokeStatus =
  | 'passed'
  | 'unsupported'
  | 'authentication_failed'
  | 'subscription_blocked'
  | 'usage_credits_required'
  | 'rate_limited'
  | 'server_error'
  | 'timed_out'
  | 'unexpected_output'
  | 'failed'

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type SmokeResult = {
  model: string
  status: SmokeStatus
  latencyMs: number
  diagnostic?: string
}

export function isBlockingSmokeStatus(status: SmokeStatus): boolean {
  return status !== 'passed' && status !== 'usage_credits_required'
}

const ansiPattern = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export function parseAnthropicModels(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^anthropic\/[^\s]+$/.test(line)),
    ),
  ].sort()
}

export function sanitizeDiagnostic(output: string): string {
  return output
    .replace(ansiPattern, '')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/\bsk-ant-[^\s"']+/gi, '<redacted>')
    .replace(
      /\b(access|refresh|access_token|refresh_token|api[_-]?key)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
      '$1=<redacted>',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

export function classifySmokeResult(result: CommandResult): SmokeStatus {
  if (result.timedOut) return 'timed_out'

  const output = `${result.stdout}\n${result.stderr}`
    .replace(ansiPattern, '')
    .toLowerCase()

  if (result.exitCode === 0 && output.includes(SENTINEL.toLowerCase())) {
    return 'passed'
  }
  if (
    output.includes('invalid model') ||
    output.includes('model not found') ||
    output.includes('unknown model') ||
    output.includes('unsupported model') ||
    output.includes('not_found_error')
  ) {
    return 'unsupported'
  }
  if (
    output.includes('usage credits are required') ||
    output.includes('requires usage credits')
  ) {
    return 'usage_credits_required'
  }
  if (
    output.includes("you're out of extra usage") ||
    output.includes('usage limit') ||
    output.includes('subscription limit')
  ) {
    return 'subscription_blocked'
  }
  if (output.includes('rate limit') || /\b429\b/.test(output)) {
    return 'rate_limited'
  }
  if (
    output.includes('unauthorized') ||
    output.includes('invalid oauth') ||
    output.includes('authentication failed') ||
    /\b(401|403)\b/.test(output)
  ) {
    return 'authentication_failed'
  }
  if (
    output.includes('overloaded') ||
    output.includes('internal server error') ||
    /\b(500|502|503|504|529)\b/.test(output)
  ) {
    return 'server_error'
  }
  if (result.exitCode === 0) return 'unexpected_output'
  return 'failed'
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  timeout.unref?.()

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)

  return { exitCode, stdout, stderr, timedOut }
}

async function main() {
  if (process.env.ANTHROPIC_LIVE_SMOKE !== '1') {
    console.error(
      'Live model tests are disabled. Set ANTHROPIC_LIVE_SMOKE=1 to run them.',
    )
    process.exitCode = 2
    return
  }

  const binary = process.env.OPENCODE_BIN?.trim() || 'opencode2'
  const cwd = process.env.ANTHROPIC_LIVE_CWD?.trim() || process.cwd()
  const standalone = process.env.OPENCODE_LIVE_STANDALONE === '1'
  const standaloneFlag = standalone ? ['--standalone'] : []
  const timeoutMs = positiveInteger(
    process.env.ANTHROPIC_LIVE_TIMEOUT_MS,
    60_000,
  )
  const delayMs = positiveInteger(process.env.ANTHROPIC_LIVE_DELAY_MS, 1_000)

  const discovery = await runCommand(
    [binary, 'models', ...standaloneFlag],
    cwd,
    timeoutMs,
  )
  if (discovery.exitCode !== 0 || discovery.timedOut) {
    throw new Error(
      `Unable to discover OpenCode models: ${sanitizeDiagnostic(`${discovery.stdout}\n${discovery.stderr}`)}`,
    )
  }

  const models = parseAnthropicModels(discovery.stdout)
  if (models.length === 0) {
    throw new Error('OpenCode returned no anthropic/* models')
  }

  console.log(`Discovered ${models.length} Anthropic models; running sequentially.`)
  const results: SmokeResult[] = []

  for (const [index, model] of models.entries()) {
    const started = performance.now()
    const result = await runCommand(
      [
        binary,
        'run',
        ...standaloneFlag,
        '--model',
        model,
        `Reply with exactly: ${SENTINEL}`,
      ],
      cwd,
      timeoutMs,
    )
    const status = classifySmokeResult(result)
    const latencyMs = Math.round(performance.now() - started)
    const diagnostic =
      status === 'passed'
        ? undefined
        : sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`)

    results.push({ model, status, latencyMs, diagnostic })
    console.log(
      `[${String(index + 1).padStart(String(models.length).length)}/${models.length}] ${model} — ${status} (${latencyMs} ms)`,
    )

    if (index < models.length - 1) await Bun.sleep(delayMs)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    modelCount: models.length,
    results,
  }
  const reportPath = process.env.ANTHROPIC_LIVE_REPORT?.trim()
  if (reportPath) {
    await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Sanitized report written to ${reportPath}`)
  }

  const counts = Object.groupBy(results, (result) => result.status)
  console.log('\nSummary:')
  for (const status of [...new Set(results.map((result) => result.status))]) {
    console.log(`  ${status}: ${counts[status]?.length ?? 0}`)
  }

  if (results.some((result) => isBlockingSmokeStatus(result.status))) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(
      error instanceof Error
        ? sanitizeDiagnostic(error.message)
        : 'Live model smoke test failed',
    )
    process.exitCode = 1
  })
}
