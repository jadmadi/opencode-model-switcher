# AGENTS.md

Guidance for agents working in this repository.

## What this is

A single-file OpenCode V2 plugin (`model-switcher.ts`) that registers slash
commands for switching model providers mid-session. No build step, no
dependencies, MIT licensed.

## Local development

Install it into the global OpenCode plugins directory and let the watcher
reload:

```sh
cp model-switcher.ts ~/.config/opencode/plugins/model-switcher.ts
touch ~/.config/opencode/plugins/model-switcher.ts   # after edits
```

Verify registration:

```sh
opencode2 api get /api/command | grep -o 'oc-[a-z-]*'
```

Check the server log when something is off:

```sh
grep model-switcher ~/.local/share/opencode/log/opencode.log | tail
```

A line matching `failed to load plugin ... cause=` is the authoritative error;
`msg="loading plugin"` without a following failure means it loaded.

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

## Customization contract

`~/.config/opencode/model-switcher.json`, overridable with
`MODEL_SWITCHER_CONFIG`, has this shape:

```json
{
  "commands": {
    "name": { "description": "...", "model": "provider/model#variant" },
    "other": { "description": "...", "models": ["provider/model"] }
  }
}
```

- Keys are command names, merged over `DEFAULTS` in `model-switcher.ts`.
- Use one of `model` or `models` per entry. `models` cycles per session,
  tracked in `ctx.storage` under `cycle/<name>/<sessionID>`.
- `disabled: true` hides a default.
- A ref is `provider/model` with an optional `#variant`. The provider ends at
  the first slash; the model may contain slashes.

## Layout

- `DEFAULTS` - the four built-in commands.
- `configPath` / `loadUserCommands` - config resolution and parsing. Invalid
  JSON logs a warning and falls back to defaults.
- `parseRef` - `provider/model#variant` to a `ModelRef`.
- `setup` - registers one command per entry via `ctx.command.transform`.
- `nextInCycle` - per-session cycling state.

## Releasing

- Use semantic commit messages.
- Changes go through a feature branch and a PR; do not push to `main`.
- The package is not published to npm. Distribution is the raw file, so keep
  the install URL in the README valid.
- When the config contract changes, update this file, the README, and
  `model-switcher.example.json` together.
