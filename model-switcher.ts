// OpenCode V2 model-switcher plugin.
//
// Registers one slash command per entry in the command map. Each command
// switches the session model. A command with a single `model` always picks
// that model; a command with `models` cycles through the list, remembering
// its position per session. A command only changes the agent when it sets
// `agent`. If a target is not in the catalog, the command fails with a clear
// error instead of switching to something that does not exist.
//
// User commands come from an optional JSON file, merged field by field over
// the defaults:
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
  agent?: string
  disabled?: boolean
}

interface UserConfig {
  commands?: Record<string, CommandConfig>
}

interface CommandInvocation {
  sessionID: string
  prompt: { text?: string; files?: unknown[] } & Record<string, unknown>
  delivery: unknown
}

interface CommandDefinition {
  name: string
  description: string
  execute: (invocation: CommandInvocation) => Promise<void>
}

interface CommandEditor {
  add(definition: CommandDefinition): void
}

const DEFAULTS: Record<string, CommandConfig> = {
  "ds-go": {
    description: "Switch to DeepSeek V4.1 via OpenCode Go",
    model: "opencode-go/deepseek-v4.1-flash",
  },
  ds: {
    description: "Switch to DeepSeek V4.1 platform",
    model: "deepseek/deepseek-flash",
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function loadUserCommands(path: string | undefined): Promise<Record<string, CommandConfig>> {
  if (!path) return {}
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return {}
    const parsed: unknown = await file.json()
    if (!isPlainObject(parsed)) {
      console.error(`model-switcher: ignoring ${path}, top level must be an object`)
      return {}
    }
    const commands = (parsed as UserConfig).commands
    if (commands === undefined) return {}
    if (!isPlainObject(commands)) {
      console.error(`model-switcher: ignoring ${path}, "commands" must be an object`)
      return {}
    }
    return commands as Record<string, CommandConfig>
  } catch (error) {
    console.error(`model-switcher: ignoring ${path}: ${error}`)
    return {}
  }
}

// Keep only fields we understand and ignore wrong types, so one bad entry
// cannot break the others.
function normalizeConfig(entry: unknown): CommandConfig | undefined {
  if (!isPlainObject(entry)) return undefined
  const config: CommandConfig = {}
  if (typeof entry.description === "string") config.description = entry.description
  if (typeof entry.model === "string") config.model = entry.model
  if (typeof entry.agent === "string") config.agent = entry.agent
  if (typeof entry.disabled === "boolean") config.disabled = entry.disabled
  if (Array.isArray(entry.models) && entry.models.every((item) => typeof item === "string")) {
    config.models = entry.models as string[]
  }
  return config
}

function refsFor(config: CommandConfig): string[] {
  if (config.models?.length) return config.models
  return config.model ? [config.model] : []
}

// "provider/model#variant". The provider ends at the first slash, the model
// may contain slashes, and the variant follows the first hash.
function parseRef(ref: string): ModelRef | undefined {
  const hash = ref.indexOf("#")
  const target = hash === -1 ? ref : ref.slice(0, hash)
  const variant = hash === -1 ? undefined : ref.slice(hash + 1)
  if (variant?.includes("#")) return undefined
  const slash = target.indexOf("/")
  if (slash < 1 || slash === target.length - 1) return undefined
  const model: ModelRef = { providerID: target.slice(0, slash), id: target.slice(slash + 1) }
  if (variant) model.variant = variant
  return model
}

function parseRefs(name: string, refs: string[]): ModelRef[] {
  const models: ModelRef[] = []
  for (const ref of refs) {
    const model = parseRef(ref)
    if (model) models.push(model)
    else console.error(`model-switcher: /${name}: ignoring bad ref "${ref}"`)
  }
  return models
}

async function knownModels(ctx: any): Promise<Set<string> | undefined> {
  try {
    const list = await ctx.catalog.model.list()
    const data: any[] = Array.isArray(list) ? list : (list?.data ?? [])
    const keys = new Set<string>()
    for (const model of data) {
      if (model?.providerID && model?.id) keys.add(`${model.providerID}/${model.id}`)
    }
    return keys.size ? keys : undefined
  } catch (error) {
    console.error(`model-switcher: could not read the model catalog: ${error}`)
    return undefined
  }
}

function missingFrom(models: ModelRef[], known: Set<string> | undefined): ModelRef[] {
  if (!known) return []
  return models.filter((model) => !known.has(`${model.providerID}/${model.id}`))
}

async function knownAgents(ctx: any): Promise<Set<string> | undefined> {
  try {
    const list = await ctx.agent.list()
    const data: any[] = Array.isArray(list) ? list : (list?.data ?? [])
    const ids = new Set<string>()
    for (const agent of data) if (agent?.id) ids.add(agent.id)
    return ids.size ? ids : undefined
  } catch (error) {
    console.error(`model-switcher: could not read the agent list: ${error}`)
    return undefined
  }
}

async function nextInCycle(ctx: any, name: string, sessionID: string, models: ModelRef[]): Promise<ModelRef> {
  const key = `cycle/${name}/${sessionID}`
  const stored = await ctx.storage.get(key)
  let index = typeof stored === "number" ? stored : -1
  // If the session already runs a model from this list, continue after it.
  try {
    const info: any = (await ctx.session.get({ sessionID })) ?? {}
    const current = info.model ?? info.data?.model
    if (current) {
      const found = models.findIndex(
        (model) => model.providerID === current.providerID && model.id === (current.id ?? current.modelID),
      )
      if (found !== -1) index = found
    }
  } catch {
    // Fall back to the stored index.
  }
  const next = (index + 1) % models.length
  await ctx.storage.set(key, next)
  return models[next]
}

const plugin = {
  id: "model-switcher",
  async setup(ctx: any) {
    const user = await loadUserCommands(configPath())
    const commands: Record<string, CommandConfig> = { ...DEFAULTS }
    for (const [name, entry] of Object.entries(user)) {
      const config = normalizeConfig(entry)
      if (!config) {
        console.error(`model-switcher: ignoring /${name}, entry must be an object`)
        continue
      }
      commands[name] = { ...(DEFAULTS[name] ?? {}), ...config }
    }

    const known = await knownModels(ctx)

    await ctx.command.transform((editor: CommandEditor) => {
      for (const [name, config] of Object.entries(commands)) {
        if (!name.trim()) {
          console.error("model-switcher: ignoring a command with an empty name")
          continue
        }
        if (config.disabled) continue

        const models = parseRefs(name, refsFor(config))
        if (models.length === 0) {
          console.error(`model-switcher: skipping /${name}, no usable models`)
          continue
        }
        for (const model of missingFrom(models, known)) {
          console.error(
            `model-switcher: /${name}: "${model.providerID}/${model.id}" is not in the catalog, will check again on use`,
          )
        }

        editor.add({
          name,
          description: config.description ?? `Switch model for ${name}`,
          execute: async ({ sessionID, prompt, delivery }: CommandInvocation) => {
            try {
              const model = models.length === 1 ? models[0] : await nextInCycle(ctx, name, sessionID, models)
              const ref = `${model.providerID}/${model.id}`
              const fresh = await knownModels(ctx)
              if (fresh && !fresh.has(ref)) throw new Error(`"${ref}" is not available`)
              if (config.agent) {
                const agents = await knownAgents(ctx)
                if (agents && !agents.has(config.agent)) throw new Error(`agent "${config.agent}" is not available`)
              }
              await ctx.session.switchModel({ sessionID, model })
              if (config.agent) await ctx.session.switchAgent({ sessionID, agent: config.agent })
              const text = typeof prompt?.text === "string" ? prompt.text.trim() : ""
              const files = Array.isArray(prompt?.files) ? prompt.files.length : 0
              if (text || files) {
                await ctx.session.prompt({ ...prompt, sessionID, delivery })
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              throw new Error(`model-switcher: /${name}: ${detail}`)
            }
          },
        })
      }
    })
  },
}

export { loadUserCommands, missingFrom, normalizeConfig, parseRef, parseRefs, refsFor }
export default plugin
