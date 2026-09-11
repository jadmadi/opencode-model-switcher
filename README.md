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

Each command switches the model and leaves the agent alone. Add `agent` to a
command to switch that too. Append a task to run it on the new model, for
example `/ds-go fix the retry logic`. A bare command only switches.

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
    },
    "oc-review": {
      "description": "Review on a frontier model",
      "model": "opencode/claude-opus-4-8",
      "agent": "plan"
    }
  }
}
```

- Each key is the command name, so `oc-thinking` becomes `/oc-thinking`.
- `model` pins one model; `models` cycles a list, remembered per session.
- `agent` is optional. Without it the command never changes the agent.
- A ref is `provider/model` with an optional `#variant`, for example
  `opencode-go/deepseek-v4-flash#max`.
- Your entries merge field by field over the defaults. You can change only the
  description of a default, or override just its model.
- Set `"disabled": true` on a default to hide it.
- The file is read when the plugin loads. After editing it, run
  `touch ~/.config/opencode/plugins/model-switcher.ts` to reload.
- Override the location with `MODEL_SWITCHER_CONFIG=/path/to/file.json`.

`model-switcher.example.json` is a starting point. Model IDs are the same ones
`opencode2 models` prints.

## When something is wrong

- An entry with the wrong type is ignored. The other entries still load.
- A command whose model is not in the model catalog fails with an error and
  does not switch. The same applies to a missing agent.

## Tests

```sh
bun test
```

OpenCode embeds Bun, so the tests use Bun's runner and globals for parity with
the plugin runtime.

## Notes

The plugin has no dependencies and exports a plain `{ id, setup }` object. The
V2 runtime does not alias `@opencode/plugin`, so the
`import { Plugin } from "@opencode/plugin"` shown in the docs does not resolve
for a local plugin file.

## License

MIT
