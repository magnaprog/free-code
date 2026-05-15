import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { ProviderAuth, ProviderAuthMap, ProviderId } from './types.js'

export type ProviderAuthStoreData = ProviderAuthMap

export function getDefaultProviderAuthStorePath(
  env: Record<string, string | undefined> = process.env,
  homeDir = homedir(),
): string {
  const dataHome = env.XDG_DATA_HOME || join(homeDir, '.local', 'share')
  return join(dataHome, 'free-code', 'auth.json')
}

export class ProviderAuthStore {
  readonly path: string

  constructor(options: { path?: string } = {}) {
    this.path = options.path ?? getDefaultProviderAuthStorePath()
  }

  async read(): Promise<ProviderAuthStoreData> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return {}
      throw error
    }

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Provider auth store must contain a JSON object')
    }

    const out: ProviderAuthStoreData = {}
    for (const [providerId, auth] of Object.entries(parsed)) {
      if (isProviderAuth(auth)) {
        out[providerId as ProviderId] = auth
      }
    }
    return out
  }

  async write(data: ProviderAuthStoreData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    })
    await chmodAuthFile(tmpPath)
    await rename(tmpPath, this.path)
    await chmodAuthFile(this.path)
  }

  async getProviderAuth(providerId: ProviderId): Promise<ProviderAuth | undefined> {
    return (await this.read())[providerId]
  }

  async setProviderAuth(
    providerId: ProviderId,
    auth: ProviderAuth,
  ): Promise<void> {
    const data = await this.read()
    data[providerId] = auth
    await this.write(data)
  }

  async removeProviderAuth(providerId: ProviderId): Promise<void> {
    const data = await this.read()
    delete data[providerId]
    await this.write(data)
  }
}

async function chmodAuthFile(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(path, 0o600)
}

function isProviderAuth(value: unknown): value is ProviderAuth {
  if (!value || typeof value !== 'object') return false
  const auth = value as Record<string, unknown>
  if (auth.type === 'none') return true
  if (auth.type === 'api') {
    return typeof auth.key === 'string'
  }
  if (auth.type === 'oauth') {
    return typeof auth.access === 'string'
  }
  return false
}
