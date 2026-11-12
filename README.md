# word-gateway · 世界网关（DSH 插件 `dsh-capability-hub`）

设置页「世界网关」板块：把 DSH **没有宿主**的拓展能力记在一处，并把插槽接好线。
它不接管 chat / 视觉——那些归 DSH 自己的「设置 → 模型」。

## 现在是什么状态

**插槽 + 接线，未接任何能力。** 五个能力（`asr` / `tts` / `decision` / `embedding` / `omni`）
可以填写、保存、重启后仍在；面板里没有任何「测试连接」按钮，服务端也没有 `invoke` 路由。
实时语音（qwen-audio-realtime / MOSS-Live）只有一张占位卡，不是配置项。

## 数据

- `<DSH_HOME>/capability-hub/registry.json`：唯一真源，**不含任何密钥**。
- 凭据走 DSH 的 `credentials` 服务（与「设置 → 模型」同一份存储）。插槽里只存**引用名**，
  缺省按接入点派生：`dashscope` → `DASHSCOPE_API_KEY`、`qwen-token-plan` → `QWEN_TOKEN_PLAN_API_KEY`。
  所以把主设置里的 provider id 起成同一个名字，两边自动共用一把 key。

```jsonc
{ "version": 1,
  "slots": {
    "asr": { "enabled": false, "kind": "dashscope", "baseURL": "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com",
             "model": "qwen-audio-3.1-asr-flash", "authRef": "DASHSCOPE_API_KEY", "note": "" }
  } }
```

`{WorkspaceId}` 是占位符，换成真实 Workspace ID 后保存即可。

## HTTP（只绑本机，同源 + 会话校验）

| 路由 | 说明 |
| --- | --- |
| `GET /dsh-capability-hub/api/state` | 插槽 + 每个 `authRef` 的 `configured / source` |
| `POST /dsh-capability-hub/api/slot` | `{ capability, patch }` 改一个插槽并落盘 |
| `POST /dsh-capability-hub/api/credential` | `{ ref, value }` 写入；`{ ref, clear: true }` 清除 |
| `GET /dsh-capability-hub/api/resolve?capability=asr` | 已启用插槽的绑定；未启用返回 `not_enabled` |
| `GET /dsh-capability-hub/api/catalog` | 每个能力在每个接入点下的候选模型（预制表 + 宿主注册表） |

没有 `invoke`：适配器要到下一轮才存在。

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

key 从环境变量读（`DASHSCOPE_API_KEY` / `QWEN_TOKEN_PLAN_API_KEY` / `SILICONFLOW_API_KEY` / `MINIMAX_API_KEY`）；
没有 key 也能跑，只报告「这个接入点有没有列表接口」。千问 Token Plan 实测没有列表接口（404），只能手填。

## 接入方式

profile 的 `bundles` 里登记 `dsh-capability-hub`（`npm run setup:components` 会做），
浏览器半由 `exports["./client"]` + `dsh.client` 声明，和 `dsh-local-voice` 同一套机制，无构建步骤。

## 测试

```bash
node plugins/capability-hub/tests/candidates.test.mjs
node plugins/capability-hub/tests/catalog.test.mjs
node plugins/capability-hub/tests/registry.test.mjs
node plugins/capability-hub/tests/http-catalog.test.mjs
node plugins/capability-hub/tests/client-render.test.mjs
```

`node --test <dir>` 在本机沙箱里会 spawn 子进程并 `EPERM`，所以逐个文件直跑。

## 已知限制

- 只认识四个接入点类型；新增供应商要先在 `src/capabilities.mjs` 加 `kind`。
- 面板不做连通性探测（本轮明确不验证），填错 URL 不会当场报错。
- 预制候选表会过期，且 `/models` 只回 id、不带能力标签，无法自动归类——新模型要人读一遍再加进表。
- `order: 9` 只影响设置页里的位置。
