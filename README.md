# opencode-model-switcher

An OpenCode V2 plugin that adds slash commands for switching models mid-session.
Commands are semantic: they name an intent, and the plugin resolves it against
the live model catalog. Nothing is hard-coded, so the commands keep working as
models come and go.

```
/free           cycle models that cost nothing
/think          cycle reasoning models
/long           400k+ context windows
/new            the newest models
/muse           the Muse family
/nvid           NVIDIA
```

Built-in groups: `/free`, `/cheap`, `/think`, `/vision`, `/long`, `/new`,
`/muse`, `/glm`, `/nvid`. A group command switches the model only. The agent
stays unless the command names one.

## OpenCode

This plugin runs on OpenCode. New accounts through my referral link get $5 in
usage credits, and I get $5 too:

https://opencode.ai/go?ref=N9H3ZEP22A

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
Tested against OpenCode v2.0.3.

To pin a release, replace `main` in the URL with a tag such as `v0.4.0`.

## Use

Each group command cycles its group, cheapest first. It also accepts:

- `list` prints the group with numbers, then `/<group> use N` switches.
- filters narrow the group, for example `/free nvidia` or `/ds think`.
- `/model` shows the current model and commands.
- `/model help` prints the grammar.
- `/model <provider>/<model>[#variant]` switches to an exact model.

Filters: `free`, `cheap` (paid), `think`, `vision`, `long`, `new`, `all`,
`provider:<id>`, `family:<name>`, or a known provider or family name.
`all` ignores your provider order for one command.

Sorts: cheapest first by default. The `new` filter sorts by release date and
keeps the newest 20.

Every group only offers tool-capable, active models. The definitions:

- free: every cost tier is zero.
- think: a reasoning field, or thinking/reasoning/effort variants.
- vision: image input.
- long: context window at or above 400k.
- new: the newest 20 by release date.

Generic groups walk your provider order, by default `opencode`,
`opencode-go`, `deepseek`, `zai-coding-plan`. Within a provider, cheapest
first. If no preferred provider matches, the command shows all providers and
says so.

## Pairs

A pair is a free primary with a paid fallback. When the session runs the
primary and a turn fails with a provider error, the plugin switches to the
fallback.

```json
"pairs": {
  "zen": {
    "primary": { "free": true, "provider": "opencode" },
    "fallback": { "cheap": true, "provider": "opencode" }
  },
  "spark": {
    "primary": "opencode/muse-spark-1.3-contributor-free",
    "fallback": "opencode/muse-spark-1.3",
    "retry": true
  }
}
```

- Each pair key becomes a command. `/zen` switches to the primary and arms the
  fallback.
- `primary` and `fallback` take a model ref or a filter. A filter resolves to
  the cheapest match.
- `retry: true` re-sends the last user prompt on the fallback, but only when
  the failed turn produced no assistant output. Off by default.
- User aborts, context overflows, and output-length errors never fall back.
- One step only. A pair never chains into another pair on its own.

`/model pairs` lists the pairs with both sides resolved.

## Customize

Create `~/.config/opencode/model-switcher.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/jadmadi/opencode-model-switcher/main/model-switcher.schema.json",
  "defaults": { "providers": ["opencode", "deepseek"] },
  "commands": {
    "ds": {
      "description": "DeepSeek platform",
      "filter": { "provider": "deepseek" }
    },
    "zai": {
      "description": "Z.AI GLM via coding plan",
      "filter": { "provider": "zai-coding-plan" }
    },
    "review": {
      "model": "opencode/claude-opus-4-8",
      "agent": "plan"
    }
  }
}
```

- Each key is the command name, so `ds` becomes `/ds`.
- A command takes a `filter` and `sort`, or pins `model` and `models`.
- `agent` is optional. Without it the command never changes the agent.
- `disabled: true` hides a built-in or a pair command.
- Your entries merge field by field over the defaults.
- The file is read when the plugin loads. After editing it, run
  `touch ~/.config/opencode/plugins/model-switcher.ts` to reload.
- Override the path with `MODEL_SWITCHER_CONFIG=/path/to/file.json`.

`model-switcher.example.json` is a starting point.
`model-switcher.schema.json` powers editor autocomplete and validation. Point
`$schema` at the file next to your config, or at the raw URL above.

Model IDs are the same ones `opencode models` prints.

Upgrading from 0.3: pinned `model` and `models` entries still work. Text after
a command is now read as filters, not as a task prompt. Use `list` and
`use N`, or send the task as your next message.

## Off-peak pricing

DeepSeek and Z.AI price by Beijing time (UTC+8); Xiaomi mimo discounts its
Pacific hours (UTC-7). DeepSeek Flash halves its rates off-peak, the
GLM-5.3-Flash zero-quota window runs 23:00 to 09:00 SGT, and peak surcharges
are waived on weekends.

Converting those windows into your own timezone is awkward, and the campaigns
move. [TokenHour](https://tokenhour.surge.sh/) maps the schedules to your local
time, shows the live rate tier, and tracks the current deals. Check it before a
long batch on `/ds` or `/zai`.

## When something is wrong

- An entry with the wrong type is ignored. The other entries still load.
- A pinned model or an agent that is not in the catalog fails with an error
  and does not switch.
- An unknown filter fails and names the valid tokens.

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
