import { join } from 'node:path'
import { prepareStateDir, projectHome } from '../../_shared/paths.mjs'
import { createRegistry } from './registry.mjs'
import { createCatalog } from './catalog.mjs'
import { registerHubHttp } from './http.mjs'
import { createSpeak, createStatus, createTranscribe } from './speak.mjs'

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
  const transcribe = createTranscribe({ registry, credentials: ctx.credentials })
  const status = createStatus({ registry, credentials: ctx.credentials })

  // 同进程的插件走这里，不走 HTTP：服务端请求没有浏览器会话，打自己的 HTTP 面必然被会话校验拒掉。
  // 这就是「网关作为能力服务对外供给」的唯一入口——消费者拿到的是一组方法，不是一个地址。
  //   speak('tts', {text, voice})          → { audio, durationMs, model, voice }
  //   transcribe('asr', {audio, format})   → { text, model, durationMs }
  //   status(capability)                   → { ready, error? }
  // HTTP 面留给面板与调试，两边共用同一份实现。
  ctx.provide('capabilityHub', { speak, transcribe, status })

  const disposeHttp = registerHubHttp(ctx, registry, createCatalog(ctx), speak, transcribe)
  ctx.effect(() => () => {
    disposeHttp()
  })
}

export default { name, inject, apply }
