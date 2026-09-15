// OpenCode V2 model-switcher plugin.
//
// Registers slash commands that switch the session model. Groups are semantic:
// a command names an intent (free, cheap, think, vision, long, new, a family,
// a provider) and the plugin resolves it against the live model catalog. No
// model IDs are hard-coded except when a user pins them.
//
// Every group command accepts:
//   <group>                 cycle the group, cheapest first
//   <group> list            print the group with numbers
//   <group> use N           switch to number N from the last list
//   <group> <filters...>    narrow the group, for example /free nvidia
//
// Pairs add a paid fallback to a primary model or filter. When the session
// runs the primary and the turn fails with a provider error, the plugin
// switches to the resolved fallback.
//
// User config comes from an optional JSON file, merged field by field over
// the defaults:
//
//   $MODEL_SWITCHER_CONFIG, or
//   $XDG_CONFIG_HOME/opencode/model-switcher.json, or
//   ~/.config/opencode/model-switcher.json
//
// The runtime does not resolve `@opencode/plugin`, so this file exports a
// plain { id, setup } object and uses Bun globals for file access.

const VERSION = "0.5.0"

interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

interface FilterConfig {
  free?: boolean
  cheap?: boolean
  think?: boolean
  vision?: boolean
  long?: boolean | number
  new?: boolean
  all?: boolean
  provider?: string
  family?: string
}

type SortMode = "cheapest" | "new" | "variants"

interface CommandConfig {
  description?: string
  filter?: FilterConfig
  sort?: SortMode
  model?: string
  models?: string[]
  agent?: string
  disabled?: boolean
}

interface PairSide {
  ref?: string
  filter?: FilterConfig
}

interface PairRule {
  name: string
  description?: string
  primary: PairSide
  fallback: PairSide
  retry: boolean
  agent?: string
  disabled: boolean
}

interface DefaultsConfig {
  providers?: string[]
  long?: number
  new?: number
  list?: number
}

interface UserConfig {
  defaults?: DefaultsConfig
  commands?: Record<string, CommandConfig>
  pairs?: Record<string, Omit<PairRule, "name">>
}

interface ModelRecord {
  providerID: string
  id: string
  name?: string
  family?: string
  cost: unknown[]
  context: number
  tools: boolean
  input: string[]
  status?: string
  enabled: boolean
  released: number
  reasoningField?: unknown
  variantSettings: unknown[]
}

interface ResolvedGroup {
  models: ModelRecord[]
  fellBack: boolean
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

interface Runtime {
  ctx: any
  defaults: Required<DefaultsConfig>
  preference: string[]
  pairs: PairRule[]
  configPath?: string
  commandNames: string[]
  fallbackBusy: Set<string>
  lastFailure: Map<string, { key: string; at: number }>
  stepModels: Map<string, ModelRef>
}

const DEFAULT_DEFAULTS: Required<DefaultsConfig> = {
  providers: ["opencode", "opencode-go", "deepseek", "zai-coding-plan"],
  long: 400000,
  new: 20,
  list: 30,
}

const DEFAULTS: Record<string, CommandConfig> = {
  free: {
    description: "Cycle models that cost nothing",
    filter: { free: true },
  },
  cheap: {
    description: "Cycle paid models, cheapest first",
    filter: { cheap: true },
  },
  think: {
    description: "Cycle reasoning models",
    filter: { think: true },
  },
  vision: {
    description: "Cycle models that accept images",
    filter: { vision: true },
  },
  long: {
    description: "Cycle models with a 400k+ context window",
    filter: { long: true },
  },
  new: {
    description: "Cycle the newest models",
    filter: { new: true },
  },
  muse: {
    description: "Cycle Muse models",
    filter: { family: "muse" },
  },
  glm: {
    description: "Cycle GLM models",
    filter: { family: "glm" },
  },
  nvid: {
    description: "Cycle NVIDIA models",
    filter: { provider: "nvidia" },
  },
}

const HELP_TEXT = [
  `model-switcher ${VERSION}`,
  "",
  "Groups cycle on repeat, cheapest first. Every group command also takes:",
  "  list            print the group with numbers",
  "  use N           switch to number N from the last list",
  "  filters         narrow the group, for example /free nvidia",
  "",
  "Built-in groups: /free /cheap /think /vision /long /new /muse /glm /nvid",
  "Filters: free, cheap, think, vision, long, new, all,",
  "         provider:<id>, family:<name>, or a known provider or family name",
  "Sorts: cheapest (default), variants (most variant settings first),",
  "       new (newest first, top 20)",
  "",
  "  /model                  current model, pair, and commands",
  "  /model help             this text",
  "  /model pairs            pairs and their fallback models",
  "  /model list [filters]   numbered list, then /model use N",
  "  /model use N            switch to number N from the last list",
  "  /model <provider>/<model>[#variant]",
].join("\n")

const FALLBACK_ERRORS = ["APIError", "ProviderAuthError", "UnknownError"]
const IGNORED_ERRORS = [
  "MessageAbortedError",
  "ContextOverflowError",
  "StructuredOutputError",
  "MessageOutputLengthError",
  "ContentFilterError",
]
const FAILURE_EVENTS = ["session.error", "session.execution.failed", "session.step.failed"]

// ---------------------------------------------------------------------------
// Config

function configPath(): string | undefined {
  if (process.env.MODEL_SWITCHER_CONFIG) return process.env.MODEL_SWITCHER_CONFIG
  const base = process.env.XDG_CONFIG_HOME || (process.env.HOME ? `${process.env.HOME}/.config` : undefined)
  return base ? `${base}/opencode/model-switcher.json` : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeFilter(entry: unknown): FilterConfig | undefined {
  if (!isPlainObject(entry)) return undefined
  const filter: FilterConfig = {}
  let any = false
  for (const key of ["free", "cheap", "think", "vision", "new", "all"] as const) {
    if (entry[key] === true) {
      filter[key] = true
      any = true
    }
  }
  if (entry.long === true) {
    filter.long = true
    any = true
  } else if (typeof entry.long === "number" && Number.isFinite(entry.long) && entry.long > 0) {
    filter.long = entry.long
    any = true
  }
  if (typeof entry.provider === "string" && entry.provider.trim()) {
    filter.provider = entry.provider.trim()
    any = true
  }
  if (typeof entry.family === "string" && entry.family.trim()) {
    filter.family = entry.family.trim()
    any = true
  }
  return any ? filter : undefined
}

function normalizeCommand(entry: unknown): CommandConfig | undefined {
  if (!isPlainObject(entry)) return undefined
  const config: CommandConfig = {}
  if (typeof entry.description === "string") config.description = entry.description
  if (typeof entry.model === "string") config.model = entry.model
  if (Array.isArray(entry.models) && entry.models.every((item) => typeof item === "string")) {
    config.models = entry.models as string[]
  }
  if (typeof entry.agent === "string") config.agent = entry.agent
  if (typeof entry.disabled === "boolean") config.disabled = entry.disabled
  if (entry.sort === "cheapest" || entry.sort === "new" || entry.sort === "variants") config.sort = entry.sort
  const filter = normalizeFilter(entry.filter)
  if (filter) config.filter = filter
  return config
}

function normalizeSide(entry: unknown): PairSide | undefined {
  if (typeof entry === "string" && entry.trim()) return { ref: entry.trim() }
  const filter = normalizeFilter(entry)
  return filter ? { filter } : undefined
}

function normalizePair(entry: unknown): Omit<PairRule, "name"> | undefined {
  if (!isPlainObject(entry)) return undefined
  const primary = normalizeSide(entry.primary)
  const fallback = normalizeSide(entry.fallback)
  if (!primary || !fallback) return undefined
  return {
    description: typeof entry.description === "string" ? entry.description : undefined,
    primary,
    fallback,
    retry: entry.retry === true,
    agent: typeof entry.agent === "string" ? entry.agent : undefined,
    disabled: entry.disabled === true,
  }
}

function normalizeDefaults(entry: unknown): DefaultsConfig | undefined {
  if (!isPlainObject(entry)) return undefined
  const defaults: DefaultsConfig = {}
  if (Array.isArray(entry.providers) && entry.providers.every((item) => typeof item === "string")) {
    const providers = (entry.providers as string[]).map((item) => item.trim()).filter(Boolean)
    if (providers.length) defaults.providers = providers
  }
  for (const key of ["long", "new", "list"] as const) {
    const value = entry[key]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) defaults[key] = Math.floor(value)
  }
  return Object.keys(defaults).length ? defaults : undefined
}

async function loadUserCommands(path?: string): Promise<UserConfig> {
  if (!path) return {}
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return {}
    const parsed: unknown = await file.json()
    if (!isPlainObject(parsed)) {
      console.error(`model-switcher: ignoring ${path}, top level must be an object`)
      return {}
    }
    const source = parsed as { defaults?: unknown; commands?: unknown; pairs?: unknown }
    const result: UserConfig = {}
    const defaults = normalizeDefaults(source.defaults)
    if (defaults) result.defaults = defaults
    if (source.commands !== undefined) {
      if (!isPlainObject(source.commands)) {
        console.error(`model-switcher: ignoring ${path}, "commands" must be an object`)
      } else {
        const commands: Record<string, CommandConfig> = {}
        for (const [name, raw] of Object.entries(source.commands)) {
          const config = normalizeCommand(raw)
          if (!config) {
            console.error(`model-switcher: ignoring /${name}, entry must be an object`)
            continue
          }
          commands[name] = config
        }
        result.commands = commands
      }
    }
    if (source.pairs !== undefined) {
      if (!isPlainObject(source.pairs)) {
        console.error(`model-switcher: ignoring ${path}, "pairs" must be an object`)
      } else {
        const pairs: Record<string, Omit<PairRule, "name">> = {}
        for (const [name, raw] of Object.entries(source.pairs)) {
          const pair = normalizePair(raw)
          if (!pair) {
            console.error(`model-switcher: ignoring pair "${name}", primary and fallback are required`)
            continue
          }
          pairs[name] = pair
        }
        result.pairs = pairs
      }
    }
    return result
  } catch (error) {
    console.error(`model-switcher: ignoring ${path}: ${error}`)
    return {}
  }
}

// ---------------------------------------------------------------------------
// Catalog

function toRecord(raw: any): ModelRecord | undefined {
  const providerID = typeof raw?.providerID === "string" ? raw.providerID : ""
  const id = typeof raw?.id === "string" ? raw.id : typeof raw?.modelID === "string" ? raw.modelID : ""
  if (!providerID || !id) return undefined
  return {
    providerID,
    id,
    name: typeof raw?.name === "string" ? raw.name : undefined,
    family: typeof raw?.family === "string" ? raw.family : undefined,
    cost: Array.isArray(raw?.cost) ? raw.cost : [],
    context: Number(raw?.limit?.context ?? 0),
    tools: raw?.capabilities?.tools === true,
    input: Array.isArray(raw?.capabilities?.input) ? raw.capabilities.input.map((item: unknown) => String(item)) : [],
    status: typeof raw?.status === "string" ? raw.status : undefined,
    enabled: raw?.enabled !== false,
    released: Number(raw?.time?.released ?? 0),
    reasoningField: raw?.compatibility?.reasoningField,
    variantSettings: Array.isArray(raw?.variants) ? raw.variants.map((variant: any) => variant?.settings) : [],
  }
}

async function loadModels(ctx: any): Promise<ModelRecord[]> {
  try {
    const list = await ctx.catalog.model.list()
    const data: any[] = Array.isArray(list) ? list : (list?.data ?? [])
    const records: ModelRecord[] = []
    for (const item of data) {
      const record = toRecord(item)
      if (record) records.push(record)
    }
    return records
  } catch (error) {
    console.error(`model-switcher: could not read the model catalog: ${error}`)
    return []
  }
}

function refOf(model: { providerID: string; id: string; variant?: string }): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

function sameModel(model: { providerID: string; id: string }, ref: { providerID: string; id: string }): boolean {
  return model.providerID === ref.providerID && model.id === ref.id
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

// ---------------------------------------------------------------------------
// Semantics

function numericCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function tierValues(tier: any): number[] {
  const values: number[] = []
  for (const value of [tier?.input, tier?.output, tier?.cache?.read, tier?.cache?.write]) {
    const number = numericCost(value)
    if (number !== undefined) values.push(number)
  }
  return values
}

function isFree(cost: unknown): boolean {
  if (!Array.isArray(cost) || cost.length === 0) return false
  let seen = false
  for (const tier of cost) {
    for (const value of tierValues(tier)) {
      seen = true
      if (value !== 0) return false
    }
  }
  return seen
}

function isPaid(cost: unknown): boolean {
  if (!Array.isArray(cost) || cost.length === 0) return false
  for (const tier of cost) {
    for (const value of tierValues(tier)) {
      if (value > 0) return true
    }
  }
  return false
}

function blendedCost(cost: unknown): number | undefined {
  if (!Array.isArray(cost) || cost.length === 0) return undefined
  const input = numericCost((cost[0] as any)?.input)
  const output = numericCost((cost[0] as any)?.output)
  if (input === undefined && output === undefined) return undefined
  return (input ?? 0) + (output ?? 0)
}

function isThinking(model: Pick<ModelRecord, "reasoningField" | "variantSettings">): boolean {
  if (model.reasoningField !== undefined && model.reasoningField !== null) return true
  for (const settings of model.variantSettings) {
    try {
      if (/(thinking|reasoning|effort)/i.test(JSON.stringify(settings ?? {}))) return true
    } catch {
      // A circular or unserializable setting cannot advertise a knob.
    }
  }
  return false
}

function familyMatches(model: ModelRecord, family: string): boolean {
  if (!model.family) return false
  return model.family.toLowerCase().startsWith(family.toLowerCase())
}

function matchesFilter(model: ModelRecord, filter: FilterConfig, defaults: Required<DefaultsConfig>): boolean {
  if (!model.tools) return false
  if (model.enabled === false) return false
  if (model.status !== undefined && model.status !== "active") return false
  if (filter.free && !isFree(model.cost)) return false
  if (filter.cheap && !isPaid(model.cost)) return false
  if (filter.think && !isThinking(model)) return false
  if (filter.vision && !model.input.includes("image")) return false
  if (filter.long) {
    const threshold = typeof filter.long === "number" ? filter.long : defaults.long
    if (model.context < threshold) return false
  }
  if (filter.provider && model.providerID !== filter.provider) return false
  if (filter.family && !familyMatches(model, filter.family)) return false
  return true
}

function variantCount(model: ModelRecord): number {
  return model.variantSettings.length
}

function rankModels(models: ModelRecord[], sort: SortMode, defaults: Required<DefaultsConfig>): ModelRecord[] {
  const ranked = [...models]
  if (sort === "new") {
    ranked.sort(
      (a, b) =>
        b.released - a.released ||
        a.providerID.localeCompare(b.providerID) ||
        a.id.localeCompare(b.id),
    )
    return ranked.slice(0, defaults.new)
  }
  const price = (model: ModelRecord): number => {
    if (isFree(model.cost)) return 0
    const blended = blendedCost(model.cost)
    return blended === undefined ? Number.POSITIVE_INFINITY : blended
  }
  if (sort === "variants") {
    ranked.sort(
      (a, b) =>
        variantCount(b) - variantCount(a) ||
        price(a) - price(b) ||
        b.released - a.released ||
        b.context - a.context ||
        a.providerID.localeCompare(b.providerID) ||
        a.id.localeCompare(b.id),
    )
    return ranked
  }
  ranked.sort(
    (a, b) =>
      price(a) - price(b) ||
      b.released - a.released ||
      b.context - a.context ||
      a.providerID.localeCompare(b.providerID) ||
      a.id.localeCompare(b.id),
  )
  return ranked
}

function resolveModels(
  models: ModelRecord[],
  filter: FilterConfig,
  sort: SortMode,
  preference: string[],
  defaults: Required<DefaultsConfig>,
): ResolvedGroup {
  const matched = models.filter((model) => matchesFilter(model, filter, defaults))
  const explicit = filter.provider !== undefined || filter.all === true
  if (explicit || preference.length === 0) return { models: rankModels(matched, sort, defaults), fellBack: false }
  const preferred = matched.filter((model) => preference.includes(model.providerID))
  if (preferred.length === 0) return { models: rankModels(matched, sort, defaults), fellBack: matched.length > 0 }
  // Provider-major: every match from the first preferred provider, then the
  // next, each ranked on its own. The new window applies to the total.
  const ordered: ModelRecord[] = []
  for (const providerID of preference) {
    const group = preferred.filter((model) => model.providerID === providerID)
    ordered.push(...rankModels(group, sort, defaults))
  }
  return { models: sort === "new" ? ordered.slice(0, defaults.new) : ordered, fellBack: false }
}

function buildVocabulary(models: ModelRecord[]): { providers: Set<string>; families: string[] } {
  const providers = new Set<string>()
  const families = new Set<string>()
  for (const model of models) {
    providers.add(model.providerID)
    if (model.family) families.add(model.family)
  }
  return { providers, families: [...families] }
}

// ---------------------------------------------------------------------------
// Grammar

interface ParsedArgs {
  action: "cycle" | "list" | "use"
  use?: number
  filter: FilterConfig
  unknown: string[]
  conflict?: string
}

function parseCommandArgs(text: string, vocab: { providers: Set<string>; families: string[] }): ParsedArgs {
  const tokens = text.trim() ? text.trim().split(/\s+/) : []
  const parsed: ParsedArgs = { action: "cycle", filter: {}, unknown: [] }
  let sawList = false
  let sawUse = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const lower = token.toLowerCase()
    if (lower === "help") {
      parsed.conflict = HELP_TEXT
      continue
    }
    if (lower === "list") {
      sawList = true
      continue
    }
    if (lower === "use") {
      sawUse = true
      const value = tokens[index + 1]
      if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
        parsed.conflict = "use needs a number, for example use 2"
        continue
      }
      parsed.use = Number(value)
      index += 1
      continue
    }
    if (lower === "free") {
      parsed.filter.free = true
      continue
    }
    if (lower === "cheap" || lower === "paid") {
      parsed.filter.cheap = true
      continue
    }
    if (lower === "think") {
      parsed.filter.think = true
      continue
    }
    if (lower === "vision") {
      parsed.filter.vision = true
      continue
    }
    if (lower === "long") {
      parsed.filter.long = true
      continue
    }
    if (lower === "new") {
      parsed.filter.new = true
      continue
    }
    if (lower === "all") {
      parsed.filter.all = true
      continue
    }
    if (lower.startsWith("provider:")) {
      const providerID = token.slice("provider:".length)
      if (providerID) {
        parsed.filter.provider = providerID
        continue
      }
    }
    if (lower.startsWith("family:")) {
      const family = token.slice("family:".length)
      if (family) {
        parsed.filter.family = family
        continue
      }
    }
    const provider = [...vocab.providers].find((id) => id.toLowerCase() === lower)
    if (provider) {
      parsed.filter.provider = provider
      continue
    }
    if (vocab.families.some((family) => family.toLowerCase().startsWith(lower))) {
      parsed.filter.family = token
      continue
    }
    parsed.unknown.push(token)
  }
  if (parsed.conflict) return parsed
  if (sawUse && sawList) return { ...parsed, conflict: "use and list cannot be combined" }
  if (sawUse) {
    parsed.action = "use"
    if (Object.keys(parsed.filter).length > 0) return { ...parsed, conflict: "use takes only a number" }
  } else if (sawList) {
    parsed.action = "list"
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Output

function formatCost(cost: unknown): string {
  if (isFree(cost)) return "free"
  const input = numericCost((Array.isArray(cost) ? (cost[0] as any) : undefined)?.input)
  const output = numericCost((Array.isArray(cost) ? (cost[0] as any) : undefined)?.output)
  if (input === undefined && output === undefined) return "cost unknown"
  const format = (value?: number): string => {
    if (value === undefined) return "?"
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
  }
  return `$${format(input)}/$${format(output)} per 1M`
}

function formatContext(context: number): string {
  if (context >= 1_000_000) return `${Number((context / 1_000_000).toFixed(1))}M`
  if (context >= 1000) return `${Math.round(context / 1000)}k`
  return String(context)
}

function describeModel(model: ModelRecord): string {
  const parts = [refOf(model)]
  if (model.name && model.name !== model.id) parts.push(model.name)
  parts.push(formatCost(model.cost))
  parts.push(`ctx ${formatContext(model.context)}`)
  const caps: string[] = []
  if (model.input.includes("image")) caps.push("image")
  if (model.input.includes("audio")) caps.push("audio")
  if (isThinking(model)) caps.push("think")
  if (caps.length) parts.push(caps.join("/"))
  return parts.join("  ")
}

function formatList(name: string, models: ModelRecord[], defaults: Required<DefaultsConfig>): string {
  const shown = models.slice(0, defaults.list)
  const lines = shown.map((model, index) => `${String(index + 1).padStart(2)}. ${describeModel(model)}`)
  const header =
    models.length > shown.length
      ? `/${name}: ${models.length} models, showing ${shown.length}`
      : `/${name}: ${models.length} models`
  const footer = shown.length ? `Switch with /${name} use N.` : "Nothing matched. Try /model help."
  return [header, ...lines, footer].join("\n")
}

function formatFilter(filter: FilterConfig): string {
  const parts: string[] = []
  for (const key of ["free", "cheap", "think", "vision", "new", "all"] as const) if (filter[key]) parts.push(key)
  if (filter.long) parts.push(typeof filter.long === "number" ? `long>=${formatContext(filter.long)}` : "long")
  if (filter.provider) parts.push(filter.provider)
  if (filter.family) parts.push(`family:${filter.family}`)
  return parts.length ? parts.join(" ") : "all models"
}

function formatStatus(runtime: Runtime, current: ModelRef | undefined, models: ModelRecord[]): string {
  const lines = [
    current ? `Model: ${refOf(current)}` : "Model: unknown",
  ]
  if (current) {
    const pair = matchPair(runtime, runtime.pairs.filter((item) => !item.disabled), models, current)
    if (pair) lines.push(`Pair: ${pair.name} (fallback armed)`)
  }
  lines.push(`Config: ${runtime.configPath ?? "none"}`)
  lines.push(`Commands: ${runtime.commandNames.join(", ")}`)
  lines.push(`model-switcher ${VERSION}`)
  lines.push("Run /model help for the grammar.")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Pairs

function matchPair(runtime: Runtime, pairs: PairRule[], models: ModelRecord[], current: ModelRef): PairRule | undefined {
  for (const pair of pairs) {
    if (pair.primary.ref) {
      const ref = parseRef(pair.primary.ref)
      if (ref && sameModel(ref, current)) return pair
      continue
    }
    if (!pair.primary.filter) continue
    const resolved = resolveModels(models, pair.primary.filter, "cheapest", runtime.preference, runtime.defaults)
    if (resolved.models.some((model) => sameModel(model, current))) return pair
  }
  return undefined
}

function sideFirst(side: PairSide, models: ModelRecord[], runtime: Runtime): ModelRecord | undefined {
  if (side.ref) {
    const ref = parseRef(side.ref)
    if (!ref) return undefined
    return models.find((model) => sameModel(model, ref))
  }
  if (!side.filter) return undefined
  const resolved = resolveModels(models, side.filter, "cheapest", runtime.preference, runtime.defaults)
  return resolved.models[0]
}

// Context overflow is reported as provider.invalid-request on this runtime, so
// the message decides. A genuine request-shape failure should fall back.
function looksLikeOverflow(message: unknown): boolean {
  if (typeof message !== "string") return false
  return /context (length|window)|too long|too many tokens|exceeds .*tokens|token limit|maximum context|prompt is too long|input is too long|request too large|request_too_large|reduce the length/i.test(
    message,
  )
}

// Two error shapes exist: the older session.error names (APIError, ...) and
// the provider.* types the live runtime emits on session.step.failed and
// session.execution.failed.
function classifyError(error: unknown): "fallback" | "ignore" {
  if (!error || typeof error !== "object") return "ignore"
  const name = (error as any).name
  if (typeof name === "string") {
    if (FALLBACK_ERRORS.includes(name)) return "fallback"
    if (IGNORED_ERRORS.includes(name)) return "ignore"
  }
  const type = (error as any).type
  if (typeof type === "string") {
    if (type === "aborted" || type === "provider.content-filter" || type === "provider.invalid-output") return "ignore"
    if (type === "provider.invalid-request") return looksLikeOverflow((error as any).message) ? "ignore" : "fallback"
    if (type.startsWith("provider.")) return "fallback"
  }
  return "ignore"
}

// One failure can produce both session.step.failed and
// session.execution.failed. The same error signature inside the window is one
// failure. Different signatures, or the same one later, fall back again.
const FAILURE_WINDOW_MS = 5000

function duplicateFailure(runtime: Runtime, sessionID: string, error: unknown): boolean {
  const key = `${(error as any)?.type ?? (error as any)?.name ?? "unknown"}:${(error as any)?.message ?? ""}`
  const now = Date.now()
  const previous = runtime.lastFailure.get(sessionID)
  runtime.lastFailure.set(sessionID, { key, at: now })
  return previous !== undefined && previous.key === key && now - previous.at < FAILURE_WINDOW_MS
}

// The failing model is the one from the last step.started, not the session
// model, which may already have moved on by the time the event is handled.
function rememberStep(runtime: Runtime, event: any): void {
  const data = event?.data ?? {}
  const sessionID = data.sessionID
  const model = data.model
  const id = model?.id ?? model?.modelID
  if (typeof sessionID !== "string" || typeof model?.providerID !== "string" || typeof id !== "string") return
  const ref: ModelRef = { providerID: model.providerID, id }
  if (typeof model.variant === "string") ref.variant = model.variant
  runtime.stepModels.set(sessionID, ref)
  if (runtime.stepModels.size > 500) runtime.stepModels.clear()
}

function forgetSession(runtime: Runtime, event: any): void {
  const sessionID = (event?.data ?? {}).sessionID
  if (typeof sessionID !== "string") return
  runtime.stepModels.delete(sessionID)
  runtime.lastFailure.delete(sessionID)
  runtime.fallbackBusy.delete(sessionID)
}

async function handleSessionError(runtime: Runtime, event: any): Promise<boolean> {
  const type = event?.type
  if (!FAILURE_EVENTS.includes(type)) return false
  const payload = event.data ?? event.properties ?? {}
  const sessionID = payload.sessionID
  if (typeof sessionID !== "string" || !sessionID) return false
  if (classifyError(payload.error) !== "fallback") return false
  if (duplicateFailure(runtime, sessionID, payload.error)) return false
  const pairs = runtime.pairs.filter((pair) => !pair.disabled)
  if (pairs.length === 0) return false
  if (runtime.fallbackBusy.has(sessionID)) return false
  runtime.fallbackBusy.add(sessionID)
  try {
    const models = await loadModels(runtime.ctx)
    if (models.length === 0) return false
    const current =
      type === "session.error" ? undefined : runtime.stepModels.get(sessionID)
    const failing = current ?? (await currentModel(runtime.ctx, sessionID))
    if (!failing) return false
    const pair = matchPair(runtime, pairs, models, failing)
    if (!pair) return false
    const target = sideFirst(pair.fallback, models, runtime)
    if (!target) return false
    await switchTo(runtime.ctx, sessionID, refOf(target), pair.agent)
    if (pair.retry) await retryLastPrompt(runtime.ctx, sessionID)
    return true
  } finally {
    runtime.fallbackBusy.delete(sessionID)
  }
}

// Re-send the last user prompt only when nothing followed it. A turn that
// already produced assistant or tool output is never repeated.
async function retryLastPrompt(ctx: any, sessionID: string): Promise<void> {
  const messages = await ctx.session.context({ sessionID }).catch(() => undefined)
  if (!Array.isArray(messages) || messages.length === 0) return
  const last = messages[messages.length - 1] as any
  if (last?.type !== "user") return
  const text = typeof last.text === "string" ? last.text.trim() : ""
  if (!text) return
  await ctx.session.prompt({ sessionID, text })
}

// ---------------------------------------------------------------------------
// Execution

async function currentModel(ctx: any, sessionID: string): Promise<ModelRef | undefined> {
  try {
    const info: any = (await ctx.session.get({ sessionID })) ?? {}
    const model = info.model ?? info.data?.model
    if (!model?.providerID || !(model.id ?? model.modelID)) return undefined
    const ref: ModelRef = { providerID: model.providerID, id: model.id ?? model.modelID }
    if (model.variant) ref.variant = model.variant
    return ref
  } catch {
    return undefined
  }
}

async function switchTo(ctx: any, sessionID: string, ref: string, agent?: string): Promise<void> {
  const model = parseRef(ref)
  if (!model) throw new Error(`bad model ref "${ref}"; use provider/model[#variant]`)
  const models = await loadModels(ctx)
  const record = models.find((item) => item.providerID === model.providerID && item.id === model.id)
  if (!record) throw new Error(`"${ref}" is not in the model catalog`)
  if (agent) {
    const agents = await knownAgents(ctx)
    if (agents && !agents.has(agent)) throw new Error(`agent "${agent}" is not available`)
  }
  await ctx.session.switchModel({ sessionID, model })
  if (agent) await ctx.session.switchAgent({ sessionID, agent })
}

async function nextInCycle(ctx: any, name: string, sessionID: string, refs: string[]): Promise<string> {
  const key = `cycle/${name}/${sessionID}`
  const stored = await ctx.storage.get(key)
  let index = -1
  if (typeof stored === "string") {
    const found = refs.indexOf(stored)
    if (found !== -1) index = found
  }
  if (index === -1) {
    const current = await currentModel(ctx, sessionID)
    if (current) {
      const found = refs.findIndex((ref) => {
        const parsed = parseRef(ref)
        return parsed ? sameModel(parsed, current) : false
      })
      if (found !== -1) index = found
    }
  }
  const next = refs[(index + 1) % refs.length]
  await ctx.storage.set(key, next)
  return next
}

async function storedList(ctx: any, name: string, sessionID: string, allowLast: boolean): Promise<string[] | undefined> {
  const own = await ctx.storage.get(`list/${name}/${sessionID}`)
  if (Array.isArray(own) && own.every((item) => typeof item === "string")) return own as string[]
  if (allowLast) {
    const last = await ctx.storage.get(`list/last/${sessionID}`)
    if (Array.isArray(last) && last.every((item) => typeof item === "string")) return last as string[]
  }
  return undefined
}

async function rememberList(ctx: any, name: string, sessionID: string, refs: string[]): Promise<void> {
  await ctx.storage.set(`list/${name}/${sessionID}`, refs)
  await ctx.storage.set(`list/last/${sessionID}`, refs)
}

function assertKnown(refs: string[], models: ModelRecord[], label: string): string[] {
  return refs.filter((ref) => {
    const parsed = parseRef(ref)
    if (!parsed) return false
    const known = models.some((model) => sameModel(model, parsed))
    if (!known) console.error(`model-switcher: ${label}: "${ref}" is not in the catalog`)
    return known
  })
}

async function executePins(
  runtime: Runtime,
  name: string,
  config: CommandConfig,
  pins: string[],
  text: string,
  sessionID: string,
): Promise<void> {
  const models = await loadModels(runtime.ctx)
  const vocab = buildVocabulary(models)
  const parsed = parseCommandArgs(text, vocab)
  if (parsed.conflict) throw new Error(parsed.conflict)
  if (parsed.unknown.length) throw new Error(unknownMessage(parsed.unknown))
  if (parsed.action === "list") {
    const known = assertKnown(pins, models, `/${name}`)
    await rememberList(runtime.ctx, name, sessionID, known)
    const records = known.map((ref) => modelFromRef(ref, models)).filter(Boolean) as ModelRecord[]
    throw new Error(formatList(name, records, runtime.defaults))
  }
  if (parsed.action === "use") {
    const list = (await storedList(runtime.ctx, name, sessionID, false)) ?? pins
    const ref = list[(parsed.use as number) - 1]
    if (!ref) throw new Error(`/${name}: no entry ${parsed.use}; run /${name} list first`)
    await switchTo(runtime.ctx, sessionID, ref, config.agent)
    return
  }
  const ref = pins.length === 1 ? pins[0] : await nextInCycle(runtime.ctx, name, sessionID, pins)
  await switchTo(runtime.ctx, sessionID, ref, config.agent)
}

function modelFromRef(ref: string, models: ModelRecord[]): ModelRecord | undefined {
  const parsed = parseRef(ref)
  if (!parsed) return undefined
  const record = models.find((model) => sameModel(model, parsed))
  return record
}

function unknownMessage(tokens: string[]): string {
  return [
    `unknown filter ${tokens.map((token) => `"${token}"`).join(", ")}`,
    "valid: free, cheap, think, vision, long, new, all, provider:<id>, family:<name>,",
    "or a known provider or family name. Run /model help.",
  ].join(" ")
}

async function executeGroup(
  runtime: Runtime,
  name: string,
  config: CommandConfig,
  models: ModelRecord[],
  text: string,
  sessionID: string,
): Promise<void> {
  const vocab = buildVocabulary(models)
  const parsed = parseCommandArgs(text, vocab)
  if (parsed.conflict) throw new Error(parsed.conflict)
  if (parsed.unknown.length) throw new Error(unknownMessage(parsed.unknown))
  const filter: FilterConfig = { ...(config.filter ?? {}), ...parsed.filter }
  if (filter.free && filter.cheap) throw new Error("free and cheap are mutually exclusive")
  const sort: SortMode = filter.new || parsed.filter.new ? "new" : (config.sort ?? "cheapest")
  const resolved = resolveModels(models, filter, sort, runtime.preference, runtime.defaults)
  if (resolved.models.length === 0) {
    throw new Error(`no model matched ${formatFilter(filter)}. Try /model help or widen the filter.`)
  }
  const note = resolved.fellBack ? "\n(no model matched your preferred providers, showing all)" : ""
  if (parsed.action === "list") {
    const shown = resolved.models.slice(0, runtime.defaults.list)
    await rememberList(runtime.ctx, name, sessionID, shown.map((model) => refOf(model)))
    throw new Error(formatList(name, resolved.models, runtime.defaults) + note)
  }
  if (parsed.action === "use") {
    const list = await storedList(runtime.ctx, name, sessionID, name === "model")
    if (!list) throw new Error(`/${name}: no list yet; run /${name} list first`)
    const ref = list[(parsed.use as number) - 1]
    if (!ref) throw new Error(`/${name}: no entry ${parsed.use}; run /${name} list first`)
    await switchTo(runtime.ctx, sessionID, ref, config.agent)
    return
  }
  const next = await nextInCycle(runtime.ctx, name, sessionID, resolved.models.map((model) => refOf(model)))
  await switchTo(runtime.ctx, sessionID, next, config.agent)
}

async function executeCommand(runtime: Runtime, name: string, config: CommandConfig, invocation: CommandInvocation): Promise<void> {
  const sessionID = invocation.sessionID
  if (typeof sessionID !== "string" || !sessionID) throw new Error(`/${name} needs a session`)
  const text = typeof invocation.prompt?.text === "string" ? invocation.prompt.text.trim() : ""
  try {
    const pins = pinRefs(config)
    if (pins.length) {
      await executePins(runtime, name, config, pins, text, sessionID)
      return
    }
    const models = await loadModels(runtime.ctx)
    await executeGroup(runtime, name, config, models, text, sessionID)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (detail === HELP_TEXT) throw new Error(detail)
    const own = `/${name}: `
    const stripped = detail.startsWith(own) ? detail.slice(own.length) : detail
    throw new Error(`model-switcher: ${own}${stripped}`)
  }
}

function pinRefs(config: CommandConfig): string[] {
  if (config.models?.length) return config.models
  return config.model ? [config.model] : []
}

async function executeModel(runtime: Runtime, invocation: CommandInvocation): Promise<void> {
  const sessionID = invocation.sessionID
  const text = typeof invocation.prompt?.text === "string" ? invocation.prompt.text.trim() : ""
  const models = await loadModels(runtime.ctx)
  if (!models.length) throw new Error("model-switcher: could not read the model catalog")
  if (text === "help") throw new Error(HELP_TEXT)
  if (text === "pairs") throw new Error(await formatPairs(runtime, models, sessionID))
  const tokens = text ? text.split(/\s+/) : []
  if (tokens.length === 1 && tokens[0].includes("/")) {
    await switchTo(runtime.ctx, sessionID, tokens[0])
    return
  }
  if (!text) {
    const current = await currentModel(runtime.ctx, sessionID)
    throw new Error(formatStatus(runtime, current, models))
  }
  await executeGroup(runtime, "model", {}, models, text, sessionID)
}

async function formatPairs(runtime: Runtime, models: ModelRecord[], sessionID: string): Promise<string> {
  const pairs = runtime.pairs.filter((pair) => !pair.disabled)
  if (pairs.length === 0) return "No pairs configured. Add a \"pairs\" object to your config."
  const current = await currentModel(runtime.ctx, sessionID)
  const lines = ["Pairs:"]
  for (const pair of pairs) {
    const source = describeSide(pair.primary, models, runtime)
    const target = describeSide(pair.fallback, models, runtime)
    const armed = current && matchPair(runtime, [pair], models, current) ? " (armed)" : ""
    lines.push(`  ${pair.name}${armed}: ${source} -> ${target}`)
  }
  lines.push("A pair falls back when its primary fails with a provider error.")
  return lines.join("\n")
}

function describeSide(side: PairSide, models: ModelRecord[], runtime: Runtime): string {
  if (side.ref) return side.ref
  const filter = side.filter ?? {}
  const resolved = resolveModels(models, filter, "cheapest", runtime.preference, runtime.defaults)
  const first = resolved.models[0]
  if (!first) return `no match for ${formatFilter(filter)}`
  if (resolved.models.length === 1) return refOf(first)
  return `any of ${resolved.models.length} (first ${refOf(first)})`
}

// ---------------------------------------------------------------------------
// Plugin

const plugin = {
  id: "model-switcher",
  async setup(ctx: any) {
    const user = await loadUserCommands(configPath())
    const defaults: Required<DefaultsConfig> = { ...DEFAULT_DEFAULTS, ...(user.defaults ?? {}) }
    const preference = defaults.providers
    const commands: Record<string, CommandConfig> = { ...DEFAULTS }
    for (const [name, config] of Object.entries(user.commands ?? {})) {
      commands[name] = { ...(DEFAULTS[name] ?? {}), ...config }
    }

    const pairs: PairRule[] = []
    for (const [name, pair] of Object.entries(user.pairs ?? {})) {
      pairs.push({ name, ...pair })
    }

    // Pair commands behave like group commands over their primary side.
    for (const pair of pairs) {
      if (pair.disabled) continue
      if (commands[pair.name]) {
        console.error(`model-switcher: pair "${pair.name}" ignored, a command with that name exists`)
        continue
      }
      const config: CommandConfig = {
        description: pair.description ?? `Use the ${pair.name} pair, fall back on provider errors`,
        agent: pair.agent,
      }
      if (pair.primary.ref) config.model = pair.primary.ref
      else config.filter = pair.primary.filter
      commands[pair.name] = config
    }

    const runtime: Runtime = {
      ctx,
      defaults,
      preference,
      pairs,
      configPath: configPath(),
      commandNames: [],
      fallbackBusy: new Set(),
      lastFailure: new Map(),
      stepModels: new Map(),
    }
    runtime.commandNames = ["model", ...Object.keys(commands).filter((name) => !commands[name].disabled)].sort()

    await ctx.command.transform((editor: CommandEditor) => {
      for (const [name, config] of Object.entries(commands)) {
        if (!name.trim()) {
          console.error("model-switcher: ignoring a command with an empty name")
          continue
        }
        if (config.disabled) continue
        editor.add({
          name,
          description: config.description ?? `Switch model for ${name}`,
          execute: (invocation: CommandInvocation) => executeCommand(runtime, name, config, invocation),
        })
      }
      editor.add({
        name: "model",
        description: "Show or switch the current model (help, pairs, list, use, refs)",
        execute: (invocation: CommandInvocation) => executeModel(runtime, invocation),
      })
    })

    if (pairs.some((pair) => !pair.disabled) && typeof ctx.event?.subscribe === "function") {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            const type = (event as any)?.type
            if (type === "session.step.started") {
              rememberStep(runtime, event)
              continue
            }
            if (type === "session.deleted") {
              forgetSession(runtime, event)
              continue
            }
            if (!FAILURE_EVENTS.includes(type)) continue
            await handleSessionError(runtime, event).catch((error: unknown) => {
              console.error(`model-switcher: fallback failed: ${error}`)
            })
          }
        } catch (error) {
          if (!controller.signal.aborted) console.error(`model-switcher: event stream stopped: ${error}`)
        }
      })()
      return () => controller.abort()
    }
  },
}

export {
  DEFAULT_DEFAULTS,
  DEFAULTS,
  HELP_TEXT,
  VERSION,
  buildVocabulary,
  classifyError,
  describeModel,
  duplicateFailure,
  executeCommand,
  forgetSession,
  formatFilter,
  formatList,
  handleSessionError,
  isFree,
  isPaid,
  isThinking,
  blendedCost,
  loadUserCommands,
  matchesFilter,
  normalizeCommand,
  normalizeDefaults,
  normalizeFilter,
  normalizePair,
  parseCommandArgs,
  parseRef,
  rankModels,
  rememberStep,
  resolveModels,
  sideFirst,
  variantCount,
}
export default plugin
