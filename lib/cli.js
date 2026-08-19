/**
 * The `rapid-mlx` CLI seam.
 *
 * The provider reads *served-model* facts over HTTP (`/v1/models`), but the
 * server has no HTTP surface for the things a user manages on disk — the
 * download cache, `pull`, and `rm` are CLI-only. Those go through the harness
 * subprocess runtime here, never `child_process` directly, so the host owns
 * process lifecycle, cancellation, and output bounds.
 *
 * `parseCached()` is a pure function kept apart from the spawn seam so the
 * fragile part — scraping a human-formatted table — is unit-testable without a
 * subprocess. It parses defensively (by field shape, not column position) so a
 * spacing change in the CLI does not silently drop rows.
 */

import { tmpdir } from 'node:os'

const DEFAULT_CLI = 'rapid-mlx'
const OUTPUT_CAP = 1 << 20 // 1 MiB is far more than any models table

/** Resolve the `rapid-mlx` executable, or throw a pointed "not found". */
export async function resolveCli(subprocess, command = DEFAULT_CLI) {
  try {
    return await subprocess.resolveExecutable(command)
  } catch (cause) {
    const detail = cause?.message ?? String(cause)
    throw new Error(`"${command}" not found on PATH: ${detail}`)
  }
}

/**
 * Run a `rapid-mlx` subcommand in collect mode and return its outcome. Never
 * throws on a non-zero exit — the caller decides what a failing exit means for
 * the specific command (a failed `pull` is a real error; a `--version` probe
 * that exits non-zero is just "CLI unhealthy").
 */
export async function runCli(subprocess, executable, args, options = {}) {
  const { timeoutMs = 120_000, graceMs = 10_000, signal } = options
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd: tmpdir(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: OUTPUT_CAP },
      stderr: { maxBytes: OUTPUT_CAP },
    },
    graceMs,
    ...(signal ? { signal } : {}),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return { code: outcome.exitCode ?? null, stdout, stderr }
}

const SIZE_UNITS = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4 }

/** Parse a human size like `5.6 GiB` into bytes, or `undefined` if unparseable. */
export function parseSize(text) {
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(String(text ?? ''))
  if (!m) return undefined
  const unit = SIZE_UNITS[m[2].toUpperCase()]
  if (unit === undefined) return undefined
  const value = Number.parseFloat(m[1])
  return Number.isFinite(value) ? Math.round(value * unit) : undefined
}

// A cached row: `<alias-or-state>  <hf/repo>  <size>  <modified>`, columns
// separated by 2+ spaces. The repo field is the anchor — it always contains a
// slash, which the header ("Alias  HF repo  Size  Modified"), the ──── rules,
// and the `Total:` line never do, so matching on it excludes them for free.
const CACHED_ROW = /^\s*(\S.*?)\s{2,}(\S+\/\S+)\s{2,}([\d.]+\s*[KMGT]?i?B)\s{2,}(.+?)\s*$/

// `(unmapped)`, `(incomplete)`, `(...)` in the alias column are states, not
// aliases — a downloaded repo with no user alias, or a partial download.
const STATE_ALIAS = /^\(([^)]+)\)$/

/**
 * Parse `rapid-mlx models --cached` output into structured rows. Unknown or
 * malformed lines are skipped, never guessed at.
 */
export function parseCached(text) {
  const models = []
  let count
  let totalBytes
  for (const line of String(text ?? '').split('\n')) {
    const header = /Cached models \((\d+) on disk\)/.exec(line)
    if (header) {
      count = Number.parseInt(header[1], 10)
      continue
    }
    const total = /Total:\s*(.+)$/.exec(line)
    if (total) {
      totalBytes = parseSize(total[1])
      continue
    }
    const row = CACHED_ROW.exec(line)
    if (!row) continue
    const [, aliasField, repo, sizeText, modified] = row
    const state = STATE_ALIAS.exec(aliasField.trim())
    models.push({
      alias: state ? null : aliasField.trim(),
      state: state ? state[1] : 'ok',
      repo,
      sizeText: sizeText.replace(/\s+/g, ' ').trim(),
      sizeBytes: parseSize(sizeText),
      modified: modified.trim(),
    })
  }
  return {
    models,
    count: count ?? models.length,
    totalBytes: totalBytes ?? models.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0),
  }
}
