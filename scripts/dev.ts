/**
 * One-command dev server.
 *
 * `bun run dev` is the only thing a developer should need.
 *
 * Default behaviour (no DATABASE_URL in the environment): the script
 * manages a local docker postgres for you.
 *
 *   1. Verifies the docker daemon is reachable.
 *   2. Starts the `postgres` compose service if it isn't running.
 *   3. Stops the `app` compose service if it IS running (it would
 *      otherwise hold port 3001 and block the local cms).
 *   4. Waits until postgres actually accepts connections.
 *
 * Escape hatch: if `DATABASE_URL` is set in the environment, the script
 * trusts it, skips all docker postgres management, and just spawns the
 * cms + vite against whatever database you pointed it at.
 *
 * Either way, the script then:
 *
 *   - Pre-checks ports 3001 (cms) and 5173 (vite) and prints an
 *     actionable message if either is held by something we don't own.
 *   - Spawns the cms (`bun --watch server/index.ts`) and vite
 *     (`vite --host 127.0.0.1`) as children, forwarding their output
 *     and signals so Ctrl+C cleanly kills both.
 */

const CMS_PORT = Number(process.env.PORT ?? '3001')
const VITE_PORT = 5173
const POSTGRES_HOST = '127.0.0.1'
const POSTGRES_PORT = 5433
// Mirrors docker-compose.yml: same user/password/db, host port 5433 → container 5432.
const DEFAULT_DATABASE_URL = `postgres://page_builder:page_builder@${POSTGRES_HOST}:${POSTGRES_PORT}/page_builder`
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
const USES_LOCAL_POSTGRES = process.env.DATABASE_URL === undefined

const decoder = new TextDecoder()

function log(msg: string): void {
  console.error(`[dev] ${msg}`)
}

function fail(msg: string): never {
  log(msg)
  process.exit(1)
}

// --- docker helpers -------------------------------------------------------

function dockerInstalled(): boolean {
  const result = Bun.spawnSync(['docker', '--version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return result.exitCode === 0
}

function dockerDaemonRunning(): boolean {
  const result = Bun.spawnSync(['docker', 'info'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return result.exitCode === 0
}

interface ComposeServiceState {
  state: 'running' | 'exited' | 'paused' | 'created' | 'restarting' | 'dead' | 'absent'
}

/**
 * Reads the state of a compose service. Handles both the NDJSON output
 * from older docker-compose versions and the JSON-array output from newer
 * versions; returns 'absent' when no entry is found.
 */
function getComposeServiceState(service: string): ComposeServiceState['state'] {
  const result = Bun.spawnSync(
    ['docker', 'compose', 'ps', '--all', '--format', 'json', service],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode !== 0) return 'absent'

  const stdout = decoder.decode(result.stdout).trim()
  if (!stdout) return 'absent'

  const parseEntry = (raw: unknown): ComposeServiceState['state'] | null => {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as { Service?: string; State?: string; Name?: string }
    if (entry.Service !== service) return null
    const state = entry.State?.toLowerCase()
    if (
      state === 'running' ||
      state === 'exited' ||
      state === 'paused' ||
      state === 'created' ||
      state === 'restarting' ||
      state === 'dead'
    ) {
      return state
    }
    return null
  }

  // Newer compose: a single JSON array.
  if (stdout.startsWith('[')) {
    try {
      const arr = JSON.parse(stdout) as unknown[]
      for (const entry of arr) {
        const state = parseEntry(entry)
        if (state) return state
      }
    } catch {
      // fall through to NDJSON
    }
  }

  // Older / default compose: one JSON object per line.
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const state = parseEntry(JSON.parse(trimmed))
      if (state) return state
    } catch {
      // ignore unparseable lines
    }
  }

  return 'absent'
}

function runDocker(args: string[], description: string): void {
  log(description)
  const result = Bun.spawnSync(['docker', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    fail(`\`docker ${args.join(' ')}\` exited with code ${result.exitCode}.`)
  }
}

function ensurePostgresRunning(): void {
  const state = getComposeServiceState('postgres')
  switch (state) {
    case 'running':
      log('Docker postgres is already running.')
      return
    case 'exited':
    case 'created':
    case 'paused':
    case 'restarting':
    case 'dead':
      runDocker(
        ['compose', 'start', 'postgres'],
        `Docker postgres is ${state} — starting it...`,
      )
      return
    case 'absent':
      runDocker(
        ['compose', 'up', '-d', 'postgres'],
        'Docker postgres container not found — creating it...',
      )
      return
  }
}

function stopAppContainerIfRunning(): void {
  const state = getComposeServiceState('app')
  if (state === 'running') {
    runDocker(
      ['compose', 'stop', 'app'],
      'Docker `app` container is running — stopping it (it would conflict with the local cms on port 3001)...',
    )
  }
}

async function waitForPostgresReady(timeoutMs = 60_000): Promise<void> {
  log(`Waiting for postgres at ${POSTGRES_HOST}:${POSTGRES_PORT}...`)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = Bun.spawnSync(
      [
        'docker',
        'compose',
        'exec',
        '-T',
        'postgres',
        'pg_isready',
        '-U',
        'page_builder',
        '-d',
        'page_builder',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    if (result.exitCode === 0) {
      log('Postgres is accepting connections.')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  fail(`Postgres did not become ready within ${timeoutMs}ms.`)
}

// --- port pre-flight ------------------------------------------------------

function checkPortAvailable(port: number, name: string): void {
  try {
    const probe = Bun.serve({ port, fetch: () => new Response() })
    probe.stop(true)
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code !== 'EADDRINUSE') throw err

    log(`Port ${port} (${name}) is already in use.`)
    log(`Run \`lsof -i :${port} -P -n\` to see which process owns it.`)
    log('If it is a leftover docker container, run `docker compose down`.')
    process.exit(1)
  }
}

// --- main -----------------------------------------------------------------

if (USES_LOCAL_POSTGRES) {
  if (!dockerInstalled()) {
    fail('Docker is not installed. Install Docker Desktop, or set DATABASE_URL to point at your own postgres.')
  }
  if (!dockerDaemonRunning()) {
    fail('Docker daemon is not running. Start Docker Desktop, or set DATABASE_URL to point at your own postgres.')
  }
  ensurePostgresRunning()
  stopAppContainerIfRunning()
  await waitForPostgresReady()
} else {
  log('DATABASE_URL is set in the environment — skipping docker postgres setup.')
}

checkPortAvailable(CMS_PORT, 'cms')
checkPortAvailable(VITE_PORT, 'vite')

// --- spawn cms + vite -----------------------------------------------------

interface DevProcess {
  name: string
  command: string
  env?: Record<string, string>
}

const processes: DevProcess[] = [
  {
    name: 'cms',
    command: 'bun --watch server/index.ts',
    env: {
      PORT: String(CMS_PORT),
      DATABASE_URL,
      STATIC_DIR: process.env.STATIC_DIR ?? './dist',
      UPLOADS_DIR: process.env.UPLOADS_DIR ?? './uploads',
    },
  },
  {
    name: 'vite',
    command: 'vite --host 127.0.0.1',
  },
]

const children: Bun.Subprocess[] = []
let shuttingDown = false

function stopChildren(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal)
  }
}

for (const cfg of processes) {
  const child = Bun.spawn(cfg.command.split(' '), {
    env: { ...process.env, ...cfg.env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  children.push(child)
  void child.exited.then((code) => {
    if (shuttingDown) return
    shuttingDown = true
    stopChildren()
    process.exit(code)
  })
}

process.on('SIGINT', () => {
  shuttingDown = true
  stopChildren('SIGINT')
})

process.on('SIGTERM', () => {
  shuttingDown = true
  stopChildren('SIGTERM')
})
