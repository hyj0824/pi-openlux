# pi-openlux

[OpenLux](https://doc.openlux.ai/) 中转站（OpenAI 兼容聚合网关）的 [pi](https://pi.dev) provider 扩展。

装完就能用：自动发现模型、按端点类型选对 API，不用手写 `models.json`。

## 特性

- **自动发现**：每次打开 `/model` 或启动时拉取 `https://api.openlux.ai/api/pricing`，新上架的模型自动出现
- **选对 API 格式**（关键修复，否则会 400）：
  - `claude-*` → `anthropic-messages`（走原生端点，能吃 prompt caching）
  - `gpt-*` → `openai-responses`（该站 `/v1/chat/completions` 不允许 tools + `reasoning_effort` 同时出现）
  - 其余 → `openai-completions`
  - 只有 gemini 端点 → `google-generative-ai`
- **元数据靠谱**：价格/阶梯价/缓存价取自中转站定价接口；上下文长度、最大输出、thinking 映射取自 pi 自带模型目录里同 id 的条目
- **可覆盖**：`~/.pi/agent/models.json` 里手写的条目优先级最高，用来给某个模型微调
- **离线可用**：发现结果缓存在 `~/.pi/agent/openlux-models.json`

## 安装

```bash
# git（推荐，多设备同步就靠它）
pi install git:github.com/<you>/pi-openlux

# 本地目录（正在改代码时用）
pi install ./pi-openlux

# 从 npm（如果发布过）
pi install npm:pi-openlux
```

更新：`pi update --extensions`。卸载：`pi remove <source>`。

## 配置 API Key

三选一：

1. 启动 `pi` 后 `/login`，选 **OpenLux 中转站**，粘贴 `sk-...`（存进 `~/.pi/agent/auth.json`，推荐）
2. 环境变量：`export OPENLUX_API_KEY=sk-...`
3. 在 `~/.pi/agent/models.json` 里写
   ```json
   { "providers": { "openlux": { "apiKey": "sk-..." } } }
   ```

## 使用

```bash
pi --list-models openlux                       # 看全部（离线）
OPENLUX_FORCE_REFRESH=1 pi --list-models openlux  # 强制联网刷新
```

在 pi 里：

- `/model`：打开时自动刷新目录
- `/openlux`：列出相对兜底清单新增的模型
- `OPENLUX_DEBUG=1`：日志写到 `/tmp/openlux-debug.log`

## 优先级

```
~/.pi/agent/models.json 里的 openlux 条目   ← 手工微调，最高
defaults/models.json（包内自带）            ← 兜底清单
中转站定价接口自动发现                       ← 其余全部
```

想给某个自动发现的模型改上下文长度或 thinking 映射，把它的 `id` 连同要改的字段抄进
`~/.pi/agent/models.json` 的 `providers.openlux.models` 即可。

只想收带「工具」标签的模型（当前约 90 个）。想放宽到全部对话模型，把
`extensions/openlux.ts` 里的 `REQUIRE_TOOL_TAG` 改成 `false`。

## 注意

- 站点的令牌分组要支持工具调用（`default`、逆向分组不支持），否则 agent 用不了
- 该站部分 Claude 上游是 AWS Bedrock，会拒绝 `eager_input_streaming` 实验字段，扩展已关闭
