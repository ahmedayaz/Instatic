import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('self-host docker config', () => {
  it('defines app and postgres services', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8')
    expect(compose).toContain('app:')
    expect(compose).toContain('postgres:')
    expect(compose).toContain('postgres:16')
  })

  it('defines persistent postgres and uploads volumes', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8')
    expect(compose).toContain('postgres_data:')
    expect(compose).toContain('uploads:')
    expect(compose).toContain('/app/uploads')
  })

  it('documents required environment variables', () => {
    const env = readFileSync('.env.example', 'utf8')
    expect(env).toContain('DATABASE_URL=')
    expect(env).toContain('SESSION_SECRET=')
    expect(env).toContain('UPLOADS_DIR=')
  })
})
