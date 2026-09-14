# AGENTS.md

Guidance for agents working in this repository, and for agents whose users ask
them to customize an installed copy.

Agents working in Jad's environment: read `~/.agents/AGENTS.md` first. Its
rules apply here too.

## What this is

A single-file OpenCode V2 plugin (`model-switcher.ts`) that registers slash
commands for switching models mid-session. Commands are semantic: they name a
filter, and the plugin resolves it against the live catalog. No build step, no
dependencies, MIT licensed.

## Local development

```sh
bun test                                             # unit tests
cp model-switcher.ts ~/.config/opencode/plugins/model-switcher.ts
touch ~/.config/opencode/plugins/model-switcher.ts   # reload after edits
```

Verify registration:

```sh
opencode api get /api/command | grep -o '"name":"[a-z-]*"'
```

Check the server log when something is off:

```sh
grep model-switcher ~/.local/share/opencode/log/opencode.log | tail
```

A line matching `failed to load plugin ... cause=` is the authoritative load
error. Plugin `console` output does not reach that log (the service sends
stdout to /dev/null and stderr to a socket), so never rely on console for
user-facing feedback. Console errors are still worth writing for development.

## Tests

`bun test` runs `model-switcher.test.ts`. Bun is a deliberate exception to the
global no-bun rule in this repository: the plugin runs inside OpenCode, which
embeds Bun, so the tests share the runtime and globals (`Bun.file`). Keep the
pure helpers exported so they stay testable.

Tests build a small fake catalog with `model()` and exercise every filter,
ranking, group resolution, the parser, pair resolution, and the fallback
handler with a fake context. When behavior changes, add a test.

## API notes

- `ctx.catalog.model.list()` returns `{ location, data: [...] }`. Entries carry
  `providerID`, `id`, `name`, `family`, `cost` (tiers with `input`, `output`,
  `cache`), `limit.context`, `capabilities.tools`, `capabilities.input`,
  `status`, `enabled`, `time.released`, `compatibility.reasoningField`, and
  `variants` (settings objects).
- `ctx.agent.list()` returns `{ location, data: [{ id, ... }] }`.
- `ctx.session.get({ sessionID })` returns the session, whose `model` is
  `{ providerID, id, variant? }`.
- `ctx.session.switchModel` and `switchAgent` accept unknown values without
  error, so validate against the catalog before switching.
- `ctx.event.subscribe({ signal })` yields public events. Failures arrive as
  `session.step.failed` or `session.execution.failed` with
  `data: { sessionID, error }`, where the error has a `type` such as
  `provider.rate-limit`, `provider.auth`, or `provider.invalid-request`. The
  older `session.error` event also exists, carrying name-based errors
  (`APIError`, `ProviderAuthError`, `MessageAbortedError`, ...). The watcher
  handles all three.
- `session.step.started` carries the step's `model`. The watcher tracks it per
  session so a pair is matched against the model that actually failed, not the
  session model, which may already have moved on.
- Throwing from a command's `execute` surfaces as `CommandExecutionError`
  (HTTP 500) with the message, and does not start a model turn.
- `ctx.session.synthetic({ sessionID, text })` adds a message and triggers a
  model turn. Do not use it for notices.
- `ctx.session.prompt` starts a normal turn. The fallback retry uses it only
  when the last message is the user's own prompt.
- Return a cleanup function from `setup`. The plugin aborts its event
  subscription that way.

## Hard constraints

- Do not import `@opencode/plugin`. The runtime does not resolve it and npm
  only publishes dev snapshots of that name. Export a plain `{ id, setup }`
  object instead: the loader only requires a default export with an `id` and a
  `setup` or `effect` function.
- Keep the plugin dependency-free. Use Bun globals such as `Bun.file` for
  file access rather than adding packages.
- Global plugins are discovered as single `.ts`/`.js` files in
  `~/.config/opencode/plugins/`. Keep this a single file.
- The user config file is read once during `setup`. A config edit needs a
  plugin reload (`touch`); never document it as live.
- Never use `ctx.session.synthetic` for user feedback. Throw an `Error`.

## Customization contract

`~/.config/opencode/model-switcher.json`, overridable with
`MODEL_SWITCHER_CONFIG`. The JSON Schema is `model-switcher.schema.json` and
the worked example is `model-switcher.example.json`.

```json
{
  "defaults": {
    "providers": ["opencode", "opencode-go", "deepseek", "zai-coding-plan"],
    "long": 400000,
    "new": 20,
    "list": 30
  },
  "commands": {
    "name": { "description": "...", "filter": { "free": true }, "sort": "cheapest" },
    "other": { "filter": { "family": "muse" }, "agent": "plan" },
    "pinned": { "models": ["opencode/a", "opencode/b"] }
  },
  "pairs": {
    "key": { "primary": "opencode/a", "fallback": { "cheap": true }, "retry": false }
  }
}
```

- `commands` keys are command names, merged field by field over `DEFAULTS`.
  A command uses `filter` plus `sort`, or pins `model`/`models`.
- `pairs` keys become commands too. A pair command cannot shadow a command;
  the command wins and the pair is ignored.
- Filters: `free`, `cheap`, `think`, `vision`, `long` (true or a number),
  `new`, `all`, `provider`, `family`. At least one key is required.
- `disabled: true` hides a default, a config command, or a pair.
- Wrong-typed fields and non-object entries are ignored; the other entries
  still load. A pair without both sides is skipped.

## Selection semantics

- Every command only offers tool-capable, `status: "active"`, enabled models.
- free: the cost array is non-empty and every value is zero. An empty cost
  array is unknown, not free.
- cheap: some cost value is positive.
- think: `reasoningField` is set, or a variant's settings serialize with
  `thinking`, `reasoning`, or `effort`.
- vision: `capabilities.input` includes `image`.
- long: `limit.context` is at or above `defaults.long` (400k).
- new: sorted by `time.released`, capped at `defaults.new` (20).
- Ranking: first-tier input plus output, free before paid, unknown last. Ties
  go to the newer release, then the larger context.
- Provider preference partitions generic groups. An explicit `provider` filter
  or `all` bypasses it. When no preferred provider matches, the plugin falls
  back to every provider and reports it.
- Families match by case-insensitive prefix, so `deepseek` covers
  `deepseek-flash` and `deepseek-thinking`.

## Grammar and state

- `cycle/<name>/<sessionID>` stores the last cycled ref. The next run continues
  after it, or after the session's current model when it is in the group.
- `list/<name>/<sessionID>` stores the numbered refs from the last list.
  `list/last/<sessionID>` stores them for `/model use N`. `use N` on a group
  reads that group's list. Pins fall back to their own order.
- `use` and `list` cannot be combined. `help` prints `HELP_TEXT`.
- Direct refs keep the `provider/model#variant` form and are validated against
  the catalog before switching.

## Pairs

A pair has a primary side and a fallback side, each a ref or a filter. The
watcher matches failure events against the failing step's model:

- Fallback types: any `provider.*` except `provider.content-filter` and
  `provider.invalid-output`. `provider.invalid-request` falls back unless the
  message reads like a context overflow, which the runtime reports under the
  same type. Legacy names that fall back: `APIError`, `ProviderAuthError`,
  `UnknownError`.
- Ignored: `aborted`, content filters, bad output, context overflow, and the
  remaining legacy names.
- The fallback resolves to the cheapest match. One switch per event, guarded by
  a per-session busy set. One failure reported as both `session.step.failed`
  and `session.execution.failed` switches once; the same error signature within
  5 seconds is treated as the same failure.
- `retry: true` re-sends the last user prompt after the switch, but only when
  the last message is that user prompt. Files are not re-attached.
- `session.deleted` clears the tracked step model and failure state.

## Layout

- `DEFAULTS` - the built-in group commands.
- `configPath` / `loadUserCommands` - config resolution and normalization.
- `normalizeFilter` / `normalizeCommand` / `normalizePair` / `normalizeDefaults`.
- `toRecord` / `loadModels` - catalog normalization from the raw API shape.
- `isFree` / `isPaid` / `isThinking` / `matchesFilter` / `rankModels` /
  `resolveModels` / `buildVocabulary` - selection.
- `parseCommandArgs` / `parseRef` - grammar.
- `describeModel` / `formatList` / `formatFilter` / `formatStatus` - output.
- `switchTo` / `nextInCycle` / `storedList` / `rememberList` - execution.
- `matchPair` / `sideFirst` / `classifyError` / `looksLikeOverflow` /
  `duplicateFailure` / `rememberStep` / `forgetSession` / `handleSessionError` -
  pairs and the failure watcher.
- `plugin.setup` - registration, pair commands, and the event subscription.

## Releasing

- Use semantic commit messages.
- Changes go through a feature branch and a PR; do not push to `main`.
- The package is not published to npm. Distribution is the raw file, so keep
  the install URL in the README valid.
- When the config contract changes, update this file, the README,
  `model-switcher.example.json`, and `model-switcher.schema.json` together.
