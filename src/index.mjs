import { join } from 'node:path'
import { prepareStateDir, projectHome } from '../../_shared/paths.mjs'
import { createRegistry } from './registry.mjs'
import { createCatalog } from './catalog.mjs'
import { registerHubHttp } from './http.mjs'
import { createSpeak, createStatus } from './speak.mjs'

export const name = 'dsh-capability-hub'

// credentials-local 在 base bundle 里，恒可用；webServer 与 connection 由 DSH 的 web 侧提供，
// connection 用于 handler 里过一遍会话校验（与 dsh-local-voice 同一做法）。
// llm / speechToText 不写进 inject：它们是可选来源，缺了面板只退化，不该让插件挂起。
export const inject = ['webServer', 'credentials', 'connection']

export function apply(ctx) {
  const home = projectHome(process.env)
  const stateDir = prepareStateDir(join(home, 'capability-hub'), '世界网关状态目录')
  const registry = createRegistry({ file: join(stateDir, 'registry.json') })
  const speak = createSpeak({ registry, credentials: ctx.credentials })
  const status = createStatus({ registry, credentials: ctx.credentials })

  // 同进程的插件（dsh-local-voice）走这里，不走 HTTP：服务端请求没有浏览器会话，
  // 打自己的 HTTP 面必然被会话校验拒掉。HTTP 面留给面板与调试，两边共用同一份实现。
  // `status` 是给「这个语音包在不在跑」这类判断用的：只回答就绪与否，不做合成。
  ctx.provide('capabilityHub', { speak, status })

  const disposeHttp = registerHubHttp(ctx, registry, createCatalog(ctx), speak)
  ctx.effect(() => () => {
    disposeHttp()
  })
}

export default { name, inject, apply }
