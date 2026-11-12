/**
 * 世界网关 —— 设置页板块（host 半的浏览器面）。
 *
 * 只做三件事：读插槽状态、改插槽参数、读写凭据引用。这里没有任何模型调用：
 * 能力接入由各功能插件在就绪后自己决定，本面板只负责把「接哪个、用哪个模型、
 * 用哪把 key」记下来。
 */
window.__ModuleLoader__.load({
  id: 'dsh-capability-hub',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useSyncExternalStore } = React

    const API = '/dsh-capability-hub/api'
    const ORDER = ['asr', 'tts', 'decision', 'embedding', 'omni']
    const KINDS = [
      ['dashscope', '百炼 · DashScope'],
      ['qwen-token-plan', '千问 · Token Plan'],
      ['siliconflow', '硅基流动'],
      ['minimax', 'MiniMax'],
    ]
    const TITLES = {
      asr: '语音识别',
      tts: '语音合成',
      decision: '决策模型',
      embedding: '向量化',
      omni: '全模态理解',
    }
    const HINTS = {
      asr: '一段音频 → 文本。给语音输入、会议与语音条做准备。',
      tts: '一段文本 → 音频。Live2D 说话时会读这里，但接入由那个项目自己决定。',
      decision: '状态与问题 → 选项 + 置信度。用于路由、判定这类结构化的选择。',
      embedding: '文本 → 向量。记忆召回的候选；是否换库由对照测决定。',
      omni: '音频 / 视频 → 文本。能「听」的那一类模型。',
    }
    const SOURCES = {
      file: '本地凭据文件',
      memory: '运行时内存',
      env: '环境变量',
      project: '项目 .env',
    }

    const CSS = `
.wg-section{--wg-line:var(--dsw-alias-border-l2,rgba(127,127,127,.24));--wg-line-strong:var(--dsw-alias-border-l3,rgba(127,127,127,.4));--wg-brand:var(--dsw-alias-brand-primary,#2f6fed);--wg-ok:var(--dsw-alias-state-success-primary,#1a7f4b);--wg-bad:var(--dsw-alias-state-error-primary,#c43b3b);--wg-fg:var(--dsw-alias-label-primary,#1f2329);--wg-fg2:var(--dsw-alias-label-secondary,rgba(0,0,0,.64));--wg-fg3:var(--dsw-alias-label-tertiary,rgba(0,0,0,.46));--wg-bg:var(--dsw-alias-bg-base,#fff);--wg-bg1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--wg-fg);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.wg-section *{box-sizing:border-box}
.wg-section h1,.wg-section h2,.wg-section p{margin:0}
.wg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.wg-title{font-size:16px;line-height:24px;font-weight:600}
.wg-intro{margin-top:2px;font-size:12.5px;line-height:20px;color:var(--wg-fg3)}
.wg-count{flex:none;font-size:11.5px;color:var(--wg-fg2);white-space:nowrap;padding-top:3px}
.wg-card{padding:12px 14px 14px;border:1px solid var(--wg-line);border-radius:12px;background:var(--wg-bg1);min-width:0}
.wg-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}
.wg-card-title{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:650}
.wg-card-hint{margin-top:3px;font-size:12px;line-height:18px;color:var(--wg-fg2)}
.wg-dot{width:7px;height:7px;border-radius:50%;background:var(--wg-fg3);flex:none}
.wg-dot.ok{background:var(--wg-ok)}
.wg-switch{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:12px;color:var(--wg-fg2);cursor:pointer;user-select:none}
.wg-switch input{width:14px;height:14px;margin:0;accent-color:var(--wg-brand)}
.wg-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:9px 11px}
.wg-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:11.5px;color:var(--wg-fg3)}
.wg-note{font-size:11px;line-height:16px;color:var(--wg-fg3)}
.wg-field.wide{grid-column:1/-1}
.wg-section input[type=text],.wg-section input[type=password],.wg-section select,.wg-section textarea{width:100%;min-width:0;font:inherit;font-size:12.5px;color:var(--wg-fg);background:var(--wg-bg);border:1px solid var(--wg-line-strong);border-radius:8px;padding:5px 8px;height:30px;outline:none}
.wg-section textarea{height:auto;min-height:30px;padding:6px 8px;resize:vertical;line-height:1.5}
.wg-section input:focus-visible,.wg-section select:focus-visible,.wg-section textarea:focus-visible{border-color:var(--wg-brand);box-shadow:0 0 0 3px rgba(47,111,237,.14)}
.wg-cred{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px dashed var(--wg-line)}
.wg-cred-state{flex:none;font-size:11.5px;color:var(--wg-bad)}
.wg-cred-state.ok{color:var(--wg-ok)}
.wg-cred input{flex:1 1 200px;max-width:320px}
.wg-btn{appearance:none;font:inherit;font-size:12px;font-weight:500;color:var(--wg-fg);background:var(--wg-bg);border:1px solid var(--wg-line-strong);border-radius:8px;padding:0 12px;height:30px;cursor:pointer;white-space:nowrap}
.wg-btn:hover{background:var(--wg-bg1)}
.wg-btn.primary{border-color:var(--wg-brand);color:#fff;background:var(--wg-brand)}
.wg-btn.primary:hover{filter:brightness(1.06)}
.wg-btn[disabled]{opacity:.5;cursor:not-allowed}
.wg-btn.quiet{border-color:transparent;color:var(--wg-fg2);background:none;padding:0 6px}
.wg-actions{display:flex;align-items:center;gap:8px;margin-top:10px}
.wg-actions .wg-gap{flex:1}
.wg-dirty{font-size:11.5px;color:var(--wg-fg3)}
.wg-placeholder{padding:12px 14px;border:1px dashed var(--wg-line-strong);border-radius:12px;color:var(--wg-fg2)}
.wg-placeholder .wg-card-title{color:var(--wg-fg2)}
.wg-ph-list{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:20px}
.wg-ph-list code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.wg-foot{font-size:11.5px;line-height:18px;color:var(--wg-fg3)}
.wg-msg{margin-top:2px;padding:7px 10px;border-radius:8px;font-size:12px}
.wg-msg.bad{color:var(--wg-bad);background:rgba(196,59,59,.08)}
.wg-msg.ok{color:var(--wg-ok);background:rgba(26,127,75,.08)}
.wg-loading{padding:14px 0;font-size:12px;color:var(--wg-fg3)}
`

    // ── HTTP ────────────────────────────────────────────────────────────────

    async function call(path, body) {
      const response = await fetch(`${API}${path}`, body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      let data = null
      try { data = await response.json() } catch { data = null }
      if (!response.ok || data?.ok === false) {
        throw new Error([data?.error, data?.hint].filter(Boolean).join('：') || `HTTP ${response.status}`)
      }
      return data
    }

    // ── 状态 ────────────────────────────────────────────────────────────────

    function createStore() {
      let state = {
        phase: 'loading',
        error: null,
        notice: null,
        slots: null,
        creds: {},
        catalog: null,
        drafts: {},
        keys: {},
        busy: null,
        recovered: false,
      }
      const listeners = new Set()
      const set = (patch) => {
        state = { ...state, ...patch }
        for (const listener of listeners) listener()
      }
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        dispose() { listeners.clear() },
        async load() {
          try {
            // 候选目录是锦上添花：它失败了也不该把整块分区拖进错误态。
            const [data, catalog] = await Promise.all([
              call('/state'),
              call('/catalog').catch(() => null),
            ])
            set({ phase: 'ready', slots: data.slots, creds: data.credentials ?? {}, recovered: data.recovered === true, drafts: {}, error: null, catalog })
          } catch (error) {
            set({ phase: 'error', error: String(error?.message ?? error) })
          }
        },
        edit(capability, field, value) {
          const draft = { ...(state.drafts[capability] ?? state.slots?.[capability]), [field]: value }
          if (field === 'kind') draft.authRef = ''
          set({ drafts: { ...state.drafts, [capability]: draft }, notice: null })
        },
        discard(capability) {
          const drafts = { ...state.drafts }
          delete drafts[capability]
          set({ drafts, notice: null })
        },
        setKey(capability, value) {
          set({ keys: { ...state.keys, [capability]: value } })
        },
        async save(capability) {
          const draft = state.drafts[capability]
          if (!draft) return
          set({ busy: capability, error: null, notice: null })
          try {
            const data = await call('/slot', { capability, patch: draft })
            const drafts = { ...state.drafts }
            delete drafts[capability]
            set({ busy: null, slots: data.slots, creds: data.credentials ?? {}, drafts, notice: `${TITLES[capability]}已保存` })
          } catch (error) {
            set({ busy: null, error: String(error?.message ?? error) })
          }
        },
        async saveKey(capability, ref) {
          const value = String(state.keys[capability] ?? '').trim()
          if (!value || !ref) return
          set({ busy: capability, error: null, notice: null })
          try {
            const data = await call('/credential', { ref, value })
            set({
              busy: null,
              creds: { ...state.creds, [ref]: data.credential },
              keys: { ...state.keys, [capability]: '' },
              notice: `${ref} 已写入 DSH 凭据存储`,
            })
          } catch (error) {
            set({ busy: null, error: String(error?.message ?? error) })
          }
        },
        async clearKey(capability, ref) {
          set({ busy: capability, error: null, notice: null })
          try {
            const data = await call('/credential', { ref, clear: true })
            set({ busy: null, creds: { ...state.creds, [ref]: data.credential }, notice: `${ref} 已清除` })
          } catch (error) {
            set({ busy: null, error: String(error?.message ?? error) })
          }
        },
      }
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    function Field({ label, wide, children }) {
      return h('label', { className: `wg-field${wide ? ' wide' : ''}` }, h('span', {}, label), children)
    }

    // `ref` 与 `key` 是 React 的保留 prop：函数组件收到字符串 ref 会直接抛
    // "Function components cannot have string refs"，整块分区被错误边界吞成空 div。
    // 所以凭据引用名一律叫 authRef，不要用 ref 当参数名。
    function CredentialRow({ capability, authRef, cred, keyValue, busy, onKey, onSave, onClear }) {
      const configured = cred?.configured === true
      return h('div', { className: 'wg-cred' },
        h('span', { className: `wg-cred-state${configured ? ' ok' : ''}` },
          configured ? `凭据已配置${cred?.source ? `（${SOURCES[cred.source] ?? cred.source}）` : ''}` : '凭据未配置'),
        h('input', {
          type: 'password',
          value: keyValue ?? '',
          placeholder: `写入 DSH 凭据存储的 ${authRef}`,
          autoComplete: 'off',
          onChange: event => onKey(event.target.value),
        }),
        h('button', {
          className: 'wg-btn',
          type: 'button',
          disabled: busy || !authRef || !String(keyValue ?? '').trim(),
          onClick: onSave,
        }, '保存凭据'),
        configured ? h('button', {
          className: 'wg-btn quiet',
          type: 'button',
          disabled: busy,
          onClick: onClear,
        }, '清除') : null)
    }

    function CapabilityCard({ capability, store, state }) {
      const saved = state.slots?.[capability] ?? {}
      const value = state.drafts[capability] ?? saved
      const dirty = state.drafts[capability] !== undefined
      const busy = state.busy === capability
      const enabled = value.enabled === true
      const suggestions = state.catalog?.models?.[capability]?.[value.kind] ?? []
      const note = state.catalog?.notes?.[capability]
      return h('div', { className: 'wg-card' },
        h('div', { className: 'wg-card-head' },
          h('div', {},
            h('div', { className: 'wg-card-title' },
              h('span', { className: `wg-dot${enabled ? ' ok' : ''}` }), TITLES[capability]),
            h('div', { className: 'wg-card-hint' }, HINTS[capability])),
          h('label', { className: 'wg-switch' },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: event => store.edit(capability, 'enabled', event.target.checked),
            }), '启用')),
        h('div', { className: 'wg-fields' },
          h(Field, { label: '接入点' },
            h('select', {
              value: value.kind ?? '',
              onChange: event => store.edit(capability, 'kind', event.target.value),
            }, KINDS.map(([id, label]) => h('option', { key: id, value: id }, label)))),
          h(Field, { label: '基址（baseURL）' },
            h('input', {
              type: 'text',
              value: value.baseURL ?? '',
              spellCheck: false,
              onChange: event => store.edit(capability, 'baseURL', event.target.value),
            })),
          h(Field, { label: '模型' },
            h('input', {
              type: 'text',
              value: value.model ?? '',
              spellCheck: false,
              onChange: event => store.edit(capability, 'model', event.target.value),
            }),
            suggestions.length
              ? h('select', {
                defaultValue: '',
                onChange: event => {
                  const picked = event.target.value
                  if (picked) store.edit(capability, 'model', picked)
                },
              },
                h('option', { value: '' }, `从 ${suggestions.length} 个候选填入…`),
                suggestions.map(model => h('option', { key: model.id, value: model.id },
                  model.name === model.id ? model.id : `${model.name} · ${model.id}`)))
              : note ? h('span', { className: 'wg-note' }, note) : null),
          h(Field, { label: '凭据引用名' },
            h('input', {
              type: 'text',
              value: value.authRef ?? '',
              spellCheck: false,
              placeholder: '留空则按接入点自动派生',
              onChange: event => store.edit(capability, 'authRef', event.target.value),
            })),
          h(Field, { label: '备注', wide: true },
            h('input', {
              type: 'text',
              value: value.note ?? '',
              placeholder: '可选：为什么接这一家',
              onChange: event => store.edit(capability, 'note', event.target.value),
            }))),
        h(CredentialRow, {
          capability,
          authRef: value.authRef ?? '',
          cred: state.creds[value.authRef ?? ''],
          keyValue: state.keys[capability] ?? '',
          busy,
          onKey: next => store.setKey(capability, next),
          onSave: () => { void store.saveKey(capability, value.authRef) },
          onClear: () => { void store.clearKey(capability, value.authRef) },
        }),
        h('div', { className: 'wg-actions' },
          h('button', {
            className: 'wg-btn primary',
            type: 'button',
            disabled: busy || !dirty,
            onClick: () => { void store.save(capability) },
          }, busy ? '保存中…' : '保存'),
          h('button', {
            className: 'wg-btn',
            type: 'button',
            disabled: busy || !dirty,
            onClick: () => store.discard(capability),
          }, '撤销'),
          h('span', { className: 'wg-gap' }),
          dirty ? h('span', { className: 'wg-dirty' }, '有未保存修改') : null))
    }

    function RealtimePlaceholder() {
      return h('div', { className: 'wg-placeholder' },
        h('div', { className: 'wg-card-title' }, h('span', { className: 'wg-dot' }), '实时语音（未接入）'),
        h('p', { className: 'wg-card-hint' },
          '全双工语音会话不是一次请求换一次结果，它要一条常驻的音频通道，因此单独留位，不占上面的插槽。'),
        h('ul', { className: 'wg-ph-list' },
          h('li', {}, h('code', {}, 'qwen-audio-realtime'), ' — 阿里，WebSocket 音频流'),
          h('li', {}, h('code', {}, 'MOSS-Live'), ' — 模思，全双工 + 语义打断')))
    }

    function WorldGatewaySection({ store }) {
      const state = useSyncExternalStore(store.subscribe, store.get)
      useEffect(() => { void store.load() }, [])

      if (state.phase === 'loading') {
        return h('section', { className: 'wg-section' },
          h('style', {}, CSS),
          h('div', { className: 'wg-loading' }, '正在读取插槽状态…'))
      }
      if (state.phase === 'error') {
        return h('section', { className: 'wg-section' },
          h('style', {}, CSS),
          h('div', { className: 'wg-head' },
            h('div', {},
              h('div', { className: 'wg-title' }, '世界网关'),
              h('p', { className: 'wg-intro' }, '只补 DSH 没有的能力；chat 与视觉请去「设置 → 模型」。'))),
          h('div', { className: 'wg-msg bad' }, `读取失败：${state.error}`),
          h('button', { className: 'wg-btn', type: 'button', onClick: () => { void store.load() } }, '重试'))
      }

      const enabledCount = ORDER.filter(capability => state.slots?.[capability]?.enabled === true).length
      return h('section', { className: 'wg-section' },
        h('style', {}, CSS),
        h('div', { className: 'wg-head' },
          h('div', {},
            h('div', { className: 'wg-title' }, '世界网关'),
            h('p', { className: 'wg-intro' },
              '把散在各处的拓展能力记在一处：接哪个、用哪个模型、用哪把 key。这里只负责「接好线」，不主动调用任何模型；chat 与视觉请去「设置 → 模型」。')),
          h('div', { className: 'wg-count' }, `已启用 ${enabledCount} / ${ORDER.length}`)),
        state.recovered ? h('div', { className: 'wg-msg bad' }, '插槽文件曾损坏，已备份并回退到默认值；请确认下面的配置。') : null,
        state.error ? h('div', { className: 'wg-msg bad' }, state.error) : null,
        state.notice ? h('div', { className: 'wg-msg ok' }, state.notice) : null,
        ...ORDER.map(capability => h(CapabilityCard, { key: capability, capability, store, state })),
        h(RealtimePlaceholder),
        h('p', { className: 'wg-foot' },
          '插槽已就绪，能力验证暂缓：上面填的内容只会被各功能插件在就绪后读取，本轮不会发起真实请求。凭据写入 DSH 的凭据存储，与「设置 → 模型」共用同一份。'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const store = createStore()
        ctx.effect(() => () => store.dispose(), 'dsh-capability-hub: settings store')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'world-gateway',
          order: 9,
          label: () => '世界网关',
          inject: () => ({ store }),
        }, WorldGatewaySection))
      },
    }
  },
})
