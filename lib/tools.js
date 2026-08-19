/**
 * Model-management tools and the `/rapid-mlx` overview command.
 *
 * The generic openai-completions route lets an agent TALK to rapid-mlx but
 * gives it no way to see what the server is serving, what is on disk, or to
 * pull/remove a model without leaving the session. These tools close that gap,
 * splitting cleanly by which surface actually owns each fact:
 *
 *   served facts (context window, reasoning, capabilities) → HTTP /v1/models
 *   download cache, pull, remove                           → `rapid-mlx` CLI
 *
 * Reads come from the structured HTTP surface; only the disk/management
 * operations shell out, and those go through the harness subprocess seam.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveCli, runCli, parseCached } from './cli.js'
import { fetchServed, checkHealth } from './management.js'

/** Compact human byte size. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** One served model rendered as a fact line. */
export function renderServed(value) {
  const models = value?.models ?? []
  if (models.length === 0) return 'No model is being served. Start one with `rapid-mlx serve <model>`.'
  const lines = [`Serving ${models.length} model(s):`]
  for (const m of models) {
    const tags = [
      m.contextWindow ? `${m.contextWindow.toLocaleString()} ctx` : undefined,
      m.reasoningParser ? `reasoning:${m.reasoningParser}` : 'no reasoning',
      m.toolCallParser ? `tools:${m.toolCallParser}` : 'no tools',
      m.isMoe ? 'MoE' : undefined,
      m.isHybrid ? 'hybrid' : undefined,
      (m.capabilities ?? []).includes('vision') ? 'vision' : undefined,
    ].filter(Boolean)
    lines.push(`- ${m.alias}${m.repo && m.repo !== m.alias ? ` (${m.repo})` : ''} — ${tags.join(', ')}`)
  }
  return lines.join('\n')
}

/** The cached-models table rendered as model-visible text. */
export function renderCached(value) {
  const models = value?.models ?? []
  const lines = [`${models.length} cached model(s), ${formatBytes(value?.totalBytes ?? 0)} on disk`]
  for (const m of models) {
    const name = m.alias ?? `${m.repo}${m.state && m.state !== 'ok' ? ` [${m.state}]` : ''}`
    lines.push(`- ${name} — ${m.sizeText ?? formatBytes(m.sizeBytes ?? 0)}${m.modified ? `, ${m.modified}` : ''}`)
  }
  return lines.join('\n')
}

/** A pull/remove operation outcome rendered as text. */
export function renderOperation(value) {
  if (value?.removed === true) return `Removed ${value.name}.`
  if (value?.ok === false) return `Failed to ${value?.op ?? 'run'} ${value?.name ?? ''}: ${value?.error ?? 'unknown error'}`.trim()
  return `${value?.op === 'pull' ? 'Pulled' : 'Done'} ${value?.name ?? ''}.`.trim()
}

/** Health rendered as two independent lines. */
export function renderHealth(value) {
  const api = value?.api ?? {}
  const cli = value?.cli ?? {}
  return [
    `API: ${api.ok ? `ok (${api.servedCount ?? 0} model(s) served)` : `down${api.error ? ` — ${api.error}` : ''}`}`,
    `CLI: ${cli.present ? `ok${cli.version ? ` (${cli.version})` : ''}` : `not found${cli.error ? ` — ${cli.error}` : ''}`}`,
  ].join('\n')
}

/**
 * Register the management tools and the `/rapid-mlx` command on the context.
 * `deps` carries the resolved config and the fetch seam so tests can inject a
 * stub server and subprocess.
 */
export function registerManagement(ctx, deps) {
  const { baseURL, fetchImpl, cliCommand } = deps
  const jsonTool = (name, description, parameters, execute) =>
    ctx.tools.register(
      defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderFor(name, value) }],
        },
        execute,
      }),
    )

  const renderFor = (name, value) => {
    switch (name) {
      case 'rapid_mlx_serving':
        return renderServed(value)
      case 'rapid_mlx_cached':
        return renderCached(value)
      case 'rapid_mlx_health':
        return renderHealth(value)
      default:
        return renderOperation(value)
    }
  }

  jsonTool(
    'rapid_mlx_serving',
    'Show the model(s) rapid-mlx is currently serving and their facts: context window, whether they can reason or call tools, MoE/hybrid architecture, and modalities.',
    {},
    async (_args, exec) => ({ models: await fetchServed(baseURL, fetchImpl, exec.signal) }),
  )

  jsonTool(
    'rapid_mlx_cached',
    'List models downloaded to the local Hugging Face cache with their on-disk size — what `rapid-mlx pull` has fetched, independent of what is being served.',
    {},
    async (_args, exec) => {
      const executable = await resolveCli(exec.subprocess ?? deps.subprocess, cliCommand)
      const { stdout } = await runCli(exec.subprocess ?? deps.subprocess, executable, ['models', '--cached'], {
        signal: exec.signal,
        timeoutMs: 30_000,
      })
      return parseCached(stdout)
    },
  )

  jsonTool(
    'rapid_mlx_pull',
    'Download a model into the local cache via `rapid-mlx pull`. Accepts an alias (e.g. qwen3.5-9b-4bit) or a Hugging Face repo id. Large models can take a while; the download is cancellable.',
    { name: { type: 'string', required: true, description: 'Model alias or Hugging Face repo id to download.' } },
    async (args, exec) => {
      const name = String(args.name)
      const executable = await resolveCli(exec.subprocess ?? deps.subprocess, cliCommand)
      // No timeout: a multi-GB download outlives any fixed deadline; the user
      // cancels through the tool's own signal instead.
      const { code, stderr } = await runCli(exec.subprocess ?? deps.subprocess, executable, ['pull', name], {
        signal: exec.signal,
        timeoutMs: Infinity,
      })
      if (code === 0) return { op: 'pull', name, ok: true }
      return { op: 'pull', name, ok: false, error: (stderr.trim().split('\n').pop() || `exit ${code}`).slice(0, 500) }
    },
  )

  jsonTool(
    'rapid_mlx_remove',
    'Delete a downloaded model from the local cache via `rapid-mlx rm` to free disk space. Accepts an alias or a Hugging Face repo id.',
    { name: { type: 'string', required: true, description: 'Model alias or Hugging Face repo id to remove.' } },
    async (args, exec) => {
      const name = String(args.name)
      const executable = await resolveCli(exec.subprocess ?? deps.subprocess, cliCommand)
      // `-y`: the CLI prompts for confirmation by default, but the subprocess
      // seam ignores stdin — without this the removal would hang on the prompt.
      const { code, stderr } = await runCli(exec.subprocess ?? deps.subprocess, executable, ['rm', '-y', name], {
        signal: exec.signal,
        timeoutMs: 60_000,
      })
      if (code === 0) return { op: 'remove', name, removed: true }
      return { op: 'remove', name, ok: false, error: (stderr.trim().split('\n').pop() || `exit ${code}`).slice(0, 500) }
    },
  )

  jsonTool(
    'rapid_mlx_health',
    'Check the rapid-mlx server and CLI: whether the HTTP API answers and whether the `rapid-mlx` command is reachable for pull/remove/cached operations.',
    {},
    async (_args, exec) =>
      checkHealth(baseURL, fetchImpl, exec.subprocess ?? deps.subprocess, cliCommand, { signal: exec.signal }),
  )

  ctx.commands.register({
    name: 'rapid-mlx',
    description: 'One-shot rapid-mlx overview: server/CLI health, the served model and its facts, and cache disk usage.',
    async handler() {
      const health = await checkHealth(baseURL, fetchImpl, deps.subprocess, cliCommand)
      const lines = ['rapid-mlx status:', `- ${renderHealth(health).split('\n').join('\n- ')}`]
      if (health.api.ok && (health.api.served?.length ?? 0) > 0) {
        lines.push('', renderServed({ models: health.api.served }))
      }
      if (health.cli.present) {
        try {
          const executable = await resolveCli(deps.subprocess, cliCommand)
          const { stdout } = await runCli(deps.subprocess, executable, ['models', '--cached'], { timeoutMs: 30_000 })
          const cached = parseCached(stdout)
          lines.push('', `Cache: ${cached.models.length} model(s), ${formatBytes(cached.totalBytes ?? 0)} on disk`)
        } catch {
          // best-effort; health already reported CLI reachability
        }
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
