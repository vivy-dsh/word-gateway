# word-gateway · 世界网关（DSH 插件 `dsh-capability-hub`）

设置页「世界网关」板块：把 DSH **没有宿主**的拓展能力记在一处，并把插槽接好线。
它不接管 chat / 视觉——那些归 DSH 自己的「设置 → 模型」。

## 现在是什么状态

**插槽 + 接线，未接任何能力。** 六个能力（`asr` / `tts` / `decision` / `embedding` / `omni` / `realtime`）
可以填写、保存、重启后仍在；面板里没有任何「测试连接」按钮，服务端也没有 `invoke` 路由
（只有 `tts` 有合成口子，见下）。实时语音是第六个插槽：只记接入参数，全双工 WS 管线尚未实现。

接入点五类：`dashscope`（百炼）、`qwen-token-plan`、`siliconflow`、`minimax`、`moss`（模思）。

## 数据

- `<DSH_HOME>/capability-hub/registry.json`：唯一真源，**不含任何密钥**。
- 凭据走 DSH 的 `credentials` 服务（与「设置 → 模型」同一份存储）。插槽里只存**引用名**，
  缺省按接入点派生：`dashscope` → `DASHSCOPE_API_KEY`、`qwen-token-plan` → `QWEN_TOKEN_PLAN_API_KEY`、
  `moss` → `MOSS_API_KEY`。所以把主设置里的 provider id 起成同一个名字，两边自动共用一把 key。

```jsonc
{ "version": 1,
  "slots": {
    "asr": { "enabled": false, "kind": "dashscope", "baseURL": "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com",
             "model": "qwen-audio-3.1-asr-flash", "authRef": "DASHSCOPE_API_KEY", "note": "" },
    "realtime": { "enabled": false, "kind": "moss", "baseURL": "wss://api.mosi.cn/v1/realtime",
                  "model": "moss-live-1.0", "authRef": "MOSS_API_KEY", "note": "" }
  } }
```

`{WorkspaceId}` 是占位符，换成真实 Workspace ID 后保存即可。实时语音的基址必须是 `wss://`，
其余能力必须是 `https://`。切接入点（`kind`）时，若调用方没同时给 `baseURL` / `model`，
服务端会填这一家的预制值；这一家没有这类模型时模型为空、保存被拒，不会把上一家的 id 留在这一家的端点上。

## 模思（MOSS）预接线

接入点 `moss` 的 API 主机是 `https://api.mosi.cn`（`platform.moss.cn` 是文档站；
`api.moss.cn` 不可用）。鉴权 `Authorization: Bearer <MOSS_API_KEY>`，凭据引用名由接入点派生为
`MOSS_API_KEY`，与 DSH「设置 → 模型」共用同一份凭据存储。

预制候选（来自官方模型页，`VERIFIED_AT = 2026-11-18`；**没有用真 key 调过 `/v1/models`**）：

| 能力 | 模型 | 上游形状 |
| --- | --- | --- |
| `asr` | `moss-transcribe-1.0`、`moss-transcribe-diarize-pro` | `POST /v1/audio/transcriptions` |
| `tts` | `moss-tts-1.5-flash`、`moss-tts-1.0-pro`、`moss-ttsd-1.0`、`moss-voice-generator-1.0` | `POST /v1/audio/speech`（TTSD 走 `/speakers`，音色生成走 `/voice/generations`） |
| `omni` | `moss-vl-1.0`（Beta，图/视频理解，不吃音频） | `POST /v1/responses` |
| `realtime` | `moss-live-1.0`（Beta） | `WSS /v1/realtime?model=moss-live-1.0` |

**没有接的两类**：`embedding`——模思没有向量模型；`decision`——Nex N2.6 属于 chat，
归 DSH「设置 → 模型」，不经过本网关。文生图（`moss-image-*`）也不在网关现有的能力枚举里。

本轮只做接线：没有模思的适配器。`tts` 插槽若选 `moss`，合成请求会如实返回
`501 NO_ADAPTER`；实时语音没有 WS 客户端。将来做实时语音时注意两点：
浏览器原生 WebSocket 不能自己带 `Authorization` 头，必须走服务端代理；
MOSS-Live 每个用户同时只允许 1 条会话连接。协议细节（`attach_session` / `session.update` /
`input_audio_buffer.*` 等事件）记在 `docs/research/moss-world-gateway-wiring.md`。

## HTTP（只绑本机，同源 + 会话校验）

| 路由 | 说明 |
| --- | --- |
| `GET /dsh-capability-hub/api/state` | 插槽 + 每个 `authRef` 的 `configured / source` |
| `POST /dsh-capability-hub/api/slot` | `{ capability, patch }` 改一个插槽并落盘 |
| `POST /dsh-capability-hub/api/credential` | `{ ref, value }` 写入；`{ ref, clear: true }` 清除 |
| `GET /dsh-capability-hub/api/resolve?capability=asr` | 已启用插槽的绑定；未启用返回 `not_enabled` |
| `GET /dsh-capability-hub/api/catalog` | 每个能力在每个接入点下的候选模型（预制表 + 宿主注册表） |
| `POST /dsh-capability-hub/api/tts` | `{ text, voice }` → wav（`X-Duration-Ms`）；语音插件的世界网关线路走这里 |

`invoke` 只开了 `tts` 一个口子：语音插件真的需要它，其余能力还没有确定的调用方与形状。
插槽本身只有 `resolve`（拿绑定），没有通用调用路由。

## 候选模型从哪来

两个来源合起来，都不发明模型名：

1. **内置预制表**（`src/candidates.mjs`）：按 `(接入点, 能力)` 放确认过的 id。
   DSH 只有 chat 模型的注册表，`asr` / `tts` / `embedding` 没有任何注册表，
   所以这三项的候选靠预制表；离线可用，不需要 key。
2. **宿主注册表**：`decision` / `omni` 额外读取「设置 → 模型」里与接入点同名的 provider，
   只收 `inputModalities` 含 audio / video 的模型给 `omni`。

面板里是「从 N 个候选填入…」的下拉，输入框永远可以手填。预制表会随厂商更新而过期，
用脚本核对：

```bash
node plugins/capability-hub/scripts/explore-endpoints.mjs          # 报告：命中 / 不在列表 / 未归类
node plugins/capability-hub/scripts/explore-endpoints.mjs --check  # 有 key 时，缺 id 就非 0 退出
```

key 从环境变量读（`DASHSCOPE_API_KEY` / `QWEN_TOKEN_PLAN_API_KEY` / `SILICONFLOW_API_KEY` / `MINIMAX_API_KEY` / `MOSS_API_KEY`）；
没有 key 也能跑，只报告「这个接入点有没有列表接口」。千问 Token Plan 实测没有列表接口（404），只能手填。
模思在无 key 时回 `403 iam api key auth failed`，说明主机与路由存在、鉴权在网关层。

## 接入方式

profile 的 `bundles` 里登记 `dsh-capability-hub`（`npm run setup:components` 会做），
浏览器半由 `exports["./client"]` + `dsh.client` 声明，和 `dsh-local-voice` 同一套机制，无构建步骤。

## 测试

```bash
node plugins/capability-hub/tests/candidates.test.mjs
node plugins/capability-hub/tests/catalog.test.mjs
node plugins/capability-hub/tests/registry.test.mjs
node plugins/capability-hub/tests/http-catalog.test.mjs
node plugins/capability-hub/tests/http-tts.test.mjs
node plugins/capability-hub/tests/client-render.test.mjs
```

`node --test <dir>` 在本机沙箱里会 spawn 子进程并 `EPERM`，所以逐个文件直跑。

## 已知限制

- 认识五个接入点类型；新增供应商要先在 `src/capabilities.mjs` 加 `kind`，再到 `candidates.mjs` 补候选。
- 面板不做连通性探测（本轮明确不验证），填错 URL 不会当场报错。
- 预制候选表会过期，且 `/models` 只回 id、不带能力标签，无法自动归类——新模型要人读一遍再加进表。
- 模思的候选 id 来自官方模型页，**没有用真 key 核对过**；有 key 后跑一次 `explore-endpoints.mjs --check`。
- 模思只有接线，没有适配器：`tts` 选 `moss` 会 `501 NO_ADAPTER`，实时语音没有 WS 客户端。
- `order: 9` 只影响设置页里的位置。
