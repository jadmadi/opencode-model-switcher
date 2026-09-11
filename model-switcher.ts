// OpenCode V2 model-switcher plugin.
//
// Registers one slash command per entry in the command map. Each command
// switches the session model (and keeps the build agent). A command with a
// single `model` always picks that model; a command with `models` cycles
// through the list, remembering its position per session.
//
// User commands come from an optional JSON file, merged over the defaults:
//
//   $MODEL_SWITCHER_CONFIG, or
//   $XDG_CONFIG_HOME/opencode/model-switcher.json, or
//   ~/.config/opencode/model-switcher.json
//
// The runtime does not resolve `@opencode/plugin`, so this file exports a
// plain { id, setup } object and uses the Bun globals for file access.

interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

interface CommandConfig {
  description?: string
  model?: string
  models?: string[]
  disabled?: boolean
}

interface UserConfig {
  commands?: Record<string, CommandConfig>
}

const DEFAULTS: Record<string, CommandConfig> = {
  "ds-go": {
    description: "Switch to DeepSeek via OpenCode Go",
    model: "opencode-go/deepseek-v4-flash",
  },
  ds: {
    description: "Switch to DeepSeek platform",
    model: "deepseek/deepseek-v4-flash",
  },
  zai: {
    description: "Switch to Z.AI GLM",
    model: "zai-coding-plan/glm-5.3",
  },
  "oc-zen": {
    description: "Cycle through OpenCode Zen free models",
    models: [
      "opencode/nemotron-3-ultra-free",
      "opencode/nemotron-3.5-lightning-free",
      "opencode/muse-spark-1.3-contributor-free",
      "opencode/muse-spark-1.2-contributor-free",
      "opencode/mimo-v2.5-free",
      "opencode/ling-3.0-flash-fin-free",
    ],
  },
}

function configPath(): string | undefined {
  if (process.env.MODEL_SWITCHER_CONFIG) return process.env.MODEL_SWITCHER_CONFIG
  const base = process.env.XDG_CONFIG_HOME || (process.env.HOME ? `${process.env.HOME}/.config` : undefined)
  return base ? `${base}/opencode/model-switcher.json` : undefined
}

async function loadUserCommands(path: string | undefined): Promise<Record<string, CommandConfig>> {
  if (!path) return {}
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return {}
    const parsed = (await file.json()) as UserConfig
    return parsed.commands ?? {}
  } catch (error) {
    console.error(`model-switcher: ignoring ${path}: ${error}`)
    return {}
  }
}

function parseRef(ref: string): ModelRef | undefined {
  const [target, variant] = ref.split("#")
  const slash = target.indexOf("/")
  if (slash < 1 || slash === target.length - 1) return undefined
  const providerID = target.slice(0, slash)
  const id = target.slice(slash + 1)
  return variant ? { providerID, id, variant } : { providerID, id }
}

const plugin = {
  id: "model-switcher",
  async setup(ctx: any) {
    const commands = { ...DEFAULTS, ...(await loadUserCommands(configPath())) }

    await ctx.command.transform((editor: any) => {
      for (const [name, config] of Object.entries(commands)) {
        if (config.disabled) continue

        const refs = config.models ?? (config.model ? [config.model] : [])
        const models = refs.map(parseRef).filter((model): model is ModelRef => Boolean(model))
        if (models.length === 0) {
          console.error(`model-switcher: skipping /${name}, no valid model refs`)
          continue
        }

        editor.add({
          name,
          description: config.description ?? `Switch model for ${name}`,
          execute: async ({ sessionID, prompt, delivery }: any) => {
            const model = models.length === 1 ? models[0] : await nextInCycle(ctx, name, sessionID, models)
            await ctx.session.switchModel({ sessionID, model })
            await ctx.session.switchAgent({ sessionID, agent: "build" })
            if (prompt.text.trim()) {
              await ctx.session.prompt({ ...prompt, sessionID, delivery })
            }
          },
        })
      }
    })
  },
}

async function nextInCycle(ctx: any, name: string, sessionID: string, models: ModelRef[]): Promise<ModelRef> {
  const key = `cycle/${name}/${sessionID}`
  const current = await ctx.storage.get(key)
  const next = ((typeof current === "number" ? current : -1) + 1) % models.length
  await ctx.storage.set(key, next)
  return models[next]
}

export default plugin
