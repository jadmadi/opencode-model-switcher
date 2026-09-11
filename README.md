# opencode-model-switcher

An OpenCode V2 plugin that adds slash commands for switching model providers
mid-session.

| Command   | Switches to                                         |
| --------- | --------------------------------------------------- |
| `/ds-go`  | `opencode-go/deepseek-v4-flash`                      |
| `/ds`     | `deepseek/deepseek-v4-flash`                         |
| `/zai`    | `zai-coding-plan/glm-5.3`                            |
| `/oc-zen` | Cycles the `opencode/*-free` Zen models, per session |

Each command switches the current session's model and keeps the `build` agent.
Append a task to run it on the newly selected model, for example
`/ds-go fix the retry logic`. A bare command only switches.

`/oc-zen` walks through the OpenCode Zen free models
(`nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`,
`muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free`,
`mimo-v2.5-free`, `ling-3.0-flash-fin-free`) and remembers its position per
session.

## Install

Copy the plugin into your OpenCode plugins directory:

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL \
  https://raw.githubusercontent.com/jadmadi/opencode-model-switcher/main/model-switcher.ts \
  -o ~/.config/opencode/plugins/model-switcher.ts
```

For a single project, put it in `.opencode/plugins/` instead. OpenCode V2
discovers single `.ts` files in those directories and hot-reloads on change.
Tested against OpenCode `0.0.0-beta-19425`.

The plugin has no dependencies and exports a plain `{ id, setup }` object.
The V2 runtime does not alias `@opencode/plugin`, so the
`import { Plugin } from "@opencode/plugin"` shown in the docs does not resolve
for a local plugin file. A dependency-free export avoids that.

## Configure

Edit `SWITCHES` and `ZEN_FREE` at the top of `model-switcher.ts`. Each entry is
a `providerID` and model `id`, using the same identifiers as `opencode2
models`.

## License

MIT
