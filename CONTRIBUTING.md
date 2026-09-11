# Contributing

Thanks for helping improve opencode-model-switcher. This guide covers how to
set up, test, and send a change.

## What we welcome

- Bug reports and fixes.
- New built-in commands that are useful to most users.
- Better docs.
- New tests.

For a big change, open an issue first so we can agree on the shape.

## Before you start

You need:

- OpenCode V2, tested on `0.0.0-beta-19425`.
- Bun, which OpenCode embeds. The tests run under Bun on purpose.

## Set up

```sh
git clone https://github.com/jadmadi/opencode-model-switcher
cd opencode-model-switcher
bun test
```

The plugin has no dependencies, so there is nothing to install.

To run your copy inside OpenCode, install it and reload:

```sh
cp model-switcher.ts ~/.config/opencode/plugins/model-switcher.ts
touch ~/.config/opencode/plugins/model-switcher.ts
```

Then check that the commands are registered:

```sh
opencode2 api get /api/command | grep -o 'oc-[a-z-]*'
```

When a command cannot do its job, throw an error from `execute`. The client
shows the message. Do not use `ctx.session.synthetic` for notices, because it
starts a model turn. Plugin `console` output is not visible to users, so it is
not a feedback channel.

## Tests

```sh
bun test
```

Add a test for any behavior you change. The pure helpers are exported for this
reason. Keep them exported.

## The rules for this plugin

These are not style preferences. The plugin stops working if you break them.

- No dependencies and no imports. The runtime does not resolve
  `@opencode/plugin`, and npm only publishes dev snapshots of it. Export a
  plain `{ id, setup }` object.
- Keep it one file. OpenCode discovers single `.ts` files in the plugins
  directory. A package directory did not load in the tested version.
- Use Bun globals such as `Bun.file` for file access.
- Validate everything that comes from the user config. One bad entry must not
  break the others.

`AGENTS.md` has the full config contract and the API details.

## Reporting a bug

Open a GitHub issue and include:

- Your OpenCode version from `opencode2 --version`.
- The command you ran and the model or agent it targets.
- The relevant `model-switcher.json` entry, with secrets removed.
- The error message, or the log line from
  `~/.local/share/opencode/log/opencode.log`.

## Sending a change

1. Create a branch: `git checkout -b fix/short-description`.
2. Make the change and add tests.
3. Run `bun test`.
4. Write a semantic commit message, for example
   `fix: reject unknown agents`.
5. Open a pull request against `main`.

Keep one pull request to one idea. If your change alters the config contract,
update `README.md`, `AGENTS.md`, and `model-switcher.example.json` in the same
pull request.

## License

By contributing, you agree that your work is released under the MIT License.
