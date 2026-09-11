# opencode-model-switcher

An OpenCode V2 plugin that adds slash commands for switching model providers
mid-session. The command set is data-driven, so you can define your own.

Defaults:

| Command   | Switches to                                        |
| --------- | -------------------------------------------------- |
| `/ds-go`  | `opencode-go/deepseek-v4-flash`                     |
| `/ds`     | `deepseek/deepseek-v4-flash`                        |
| `/zai`    | `zai-coding-plan/glm-5.3`                           |
| `/oc-zen` | Cycles the six `opencode/*-free` Zen models         |

Each command switches the current session's model and keeps the `build` agent.
Append a task to run it on the newly selected model, for example
`/ds-go fix the retry logic`. A bare command only switches.

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

## Customize

Create `~/.config/opencode/model-switcher.json`:

```json
{
  "commands": {
    "oc-thinking": {
      "description": "Cycle frontier models for complex tasks",
      "models": [
        "opencode/claude-opus-4-8",
        "opencode/gpt-5.6-luna",
        "opencode/gemini-3.1-pro"
      ]
    },
    "oc-quick": {
      "description": "Fast, cheap edits",
      "model": "opencode/gemini-3.8-flash"
    }
  }
}
```

- Each key is the command name, so `oc-thinking` becomes `/oc-thinking`.
- `model` pins one model; `models` cycles through a list and remembers its
  position per session.
- A ref is `provider/model` with an optional `#variant`, for example
  `opencode-go/deepseek-v4-flash#max`.
- Entries merge over the defaults, so your commands are added and a key that
  matches a default replaces it.
- Set `"disabled": true` on a default to hide it.
- The file is read when the plugin loads. After editing it, run
  `touch ~/.config/opencode/plugins/model-switcher.ts` to reload.
- Override the location with `MODEL_SWITCHER_CONFIG=/path/to/file.json`.

`model-switcher.example.json` is a ready starting point. Model IDs are the
same ones `opencode2 models` prints.

## Notes

The plugin has no dependencies and exports a plain `{ id, setup }` object. The
V2 runtime does not alias `@opencode/plugin`, so the
`import { Plugin } from "@opencode/plugin"` shown in the docs does not resolve
for a local plugin file.

## License

MIT
