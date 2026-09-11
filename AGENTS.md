# AGENTS.md

Guidance for agents working in this repository.

## What this is

A single-file OpenCode V2 plugin (`model-switcher.ts`) that registers slash
commands for switching model providers mid-session. No build step, no
dependencies, MIT licensed.

## Local development

```sh
bun test                                             # unit tests
cp model-switcher.ts ~/.config/opencode/plugins/model-switcher.ts
touch ~/.config/opencode/plugins/model-switcher.ts   # reload after edits
```

Verify registration:

```sh
opencode2 api get /api/command | grep -o 'oc-[a-z-]*'
```

Check the server log when something is off:

```sh
grep model-switcher ~/.local/share/opencode/log/opencode.log | tail
```

A line matching `failed to load plugin ... cause=` is the authoritative load
error. Plugin `console` output does not reach that log (the service sends
stdout to /dev/null and stderr to a socket), so never rely on console for
user-facing feedback.

## Tests

`bun test` runs `model-switcher.test.ts`. Bun is a deliberate exception to the
global no-bun rule in this repository: the plugin runs inside OpenCode, which
embeds Bun, so the tests share the runtime and globals (`Bun.file`). Keep the
pure helpers exported so they stay testable.

## API notes

- `ctx.catalog.model.list()` and `ctx.agent.list()` return
  `{ location, data: [...] }`. Model entries have `providerID` and `id`;
  agent entries have `id`.
- `ctx.session.get({ sessionID })` returns the session, whose `model` is
  `{ providerID, id, variant? }`.
- `ctx.session.switchModel` and `switchAgent` accept unknown values without
  error, so validate against the catalog before switching.
- Throwing from a command's `execute` surfaces as `CommandExecutionError`
  (HTTP 500) with the message, and does not start a model turn.
- `ctx.session.synthetic({ sessionID, text })` adds a message and triggers a
  model turn. Do not use it for notices.

## Hard constraints

- Do not import `@opencode/plugin`. The runtime does not resolve it and npm
  only publishes dev snapshots of that name. Export a plain `{ id, setup }`
  object instead: the loader only requires a default export with an `id` and a
  `setup` or `effect` function.
- Keep the plugin dependency-free. Use Bun globals such as `Bun.file` for
  file access rather than adding packages.
- Global plugins are discovered as single `.ts`/`.js` files in
  `~/.config/opencode/plugins/`. Package directories and absolute paths in the
  config `plugins` array were not loaded under `0.0.0-beta-19425`, so do not
  restructure this into a package.
- The user config file is read once during `setup`. A config edit needs a
  plugin reload (`touch`); never document it as live.
- Never use `ctx.session.synthetic` for user feedback. Throw an `Error`.

## Customization contract

`~/.config/opencode/model-switcher.json`, overridable with
`MODEL_SWITCHER_CONFIG`:

```json
{
  "commands": {
    "name": { "description": "...", "model": "provider/model#variant" },
    "other": { "description": "...", "models": ["provider/model"], "agent": "plan" }
  }
}
```

- Keys are command names, merged field by field over `DEFAULTS`.
- Use one of `model` or `models`. `models` cycles per session, tracked in
  `ctx.storage` under `cycle/<name>/<sessionID>`. If the session already runs
  a model from the list, cycling continues after it.
- `agent` is optional and only switches the agent when present.
- `disabled: true` hides a default.
- A ref is `provider/model` with an optional `#variant`. The provider ends at
  the first slash; the model may contain slashes.
- Wrong-typed fields and non-object entries are ignored; the other entries
  still load. A command with no usable models is skipped.

## Layout

- `DEFAULTS` - the four built-in commands.
- `configPath` / `loadUserCommands` - config resolution and parsing.
- `normalizeConfig` / `refsFor` - per-entry validation.
- `parseRef` / `parseRefs` - ref parsing.
- `knownModels` / `knownAgents` / `missingFrom` - catalog checks.
- `setup` - registers one command per entry via `ctx.command.transform`.
- `nextInCycle` - per-session cycling state.
- `model-switcher.test.ts` - tests for the pure helpers and setup/execute.

## Releasing

- Use semantic commit messages.
- Changes go through a feature branch and a PR; do not push to `main`.
- The package is not published to npm. Distribution is the raw file, so keep
  the install URL in the README valid.
- When the config contract changes, update this file, the README, and
  `model-switcher.example.json` together.
