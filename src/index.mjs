import { join } from 'node:path'
import { prepareStateDir, projectHome } from '../../_shared/paths.mjs'
import { createRegistry } from './registry.mjs'
import { createCatalog } from './catalog.mjs'
import { registerHubHttp } from './http.mjs'

export const name = 'dsh-capability-hub'

// credentials-local 在 base bundle 里，恒可用；webServer 与 connection 由 DSH 的 web 侧提供，
// connection 用于 handler 里过一遍会话校验（与 dsh-local-voice 同一做法）。
// llm / speechToText 不写进 inject：它们是可选来源，缺了面板只退化，不该让插件挂起。
export const inject = ['webServer', 'credentials', 'connection']

export function apply(ctx) {
  const home = projectHome(process.env)
  const stateDir = prepareStateDir(join(home, 'capability-hub'), '世界网关状态目录')
  const registry = createRegistry({ file: join(stateDir, 'registry.json') })
  const disposeHttp = registerHubHttp(ctx, registry, createCatalog(ctx))
  ctx.effect(() => () => {
    disposeHttp()
  })
}

export default { name, inject, apply }
