import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, {
  DEFAULT_DEFAULTS,
  HELP_TEXT,
  VERSION,
  buildVocabulary,
  classifyError,
  describeModel,
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
} from "./model-switcher.ts"

function model(overrides: Record<string, unknown>): any {
  return {
    providerID: "opencode",
    id: "model-a",
    name: "Model A",
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    limit: { context: 200000, output: 100000 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    status: "active",
    enabled: true,
    time: { released: 1000 },
    ...overrides,
  }
}

// A small catalog that exercises every filter: free and paid models on two
// providers, a reasoning family, a vision model, a long window, and models
// that must never be selected (no tools, beta, disabled).
function catalog(): any[] {
  return [
    model({ id: "mimo-free", name: "Mimo Free", family: "mimo-free", time: { released: 5000 } }),
    model({
      id: "nemotron-free",
      name: "Nemotron Free",
      family: "nemotron-free",
      time: { released: 4000 },
      compatibility: { reasoningField: "reasoning_content" },
      limit: { context: 1000000, output: 100000 },
    }),
    model({
      id: "glm-5.3-flash",
      name: "GLM-5.3-Flash",
      family: "glm",
      cost: [{ input: 0.15, output: 0.5, cache: { read: 0.05, write: 0 } }],
      limit: { context: 200000, output: 100000 },
    }),
    model({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      family: "deepseek-flash",
      cost: [{ input: 0.14, output: 0.28, cache: { read: 0.05, write: 0 } }],
    }),
    model({
      id: "kimi-k3",
      name: "Kimi K3",
      family: "kimi-k3",
      cost: [{ input: 3, output: 15, cache: { read: 0.5, write: 0 } }],
      variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
    }),
    model({
      providerID: "zai-coding-plan",
      id: "glm-4.7",
      name: "GLM-4.7",
      family: "glm",
      time: { released: 3000 },
    }),
    model({
      providerID: "nvidia",
      id: "nvidia-nemotron",
      name: "NVIDIA Nemotron",
      family: "nemotron",
      time: { released: 2000 },
    }),
    model({
      id: "muse-spark",
      name: "Muse Spark",
      family: "muse",
      cost: [{ input: 1.25, output: 5, cache: { read: 0.1, write: 0 } }],
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [
        { id: "minimal", settings: { reasoningEffort: "minimal" } },
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
        { id: "high", settings: { reasoningEffort: "high" } },
        { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
        { id: "max", settings: { reasoningEffort: "max" } },
      ],
    }),
    model({ id: "no-tools", name: "No Tools", capabilities: { tools: false, input: ["text"], output: ["text"] } }),
    model({ id: "beta-model", name: "Beta", status: "beta" }),
    model({ id: "disabled-model", name: "Disabled", enabled: false }),
    model({ id: "unknown-cost", name: "Unknown Cost", cost: [] }),
  ]
}

const defaults = { ...DEFAULT_DEFAULTS }
const preference = [...DEFAULT_DEFAULTS.providers]
const vocab = buildVocabulary(
  catalog().map((entry) => ({
    providerID: entry.providerID,
    id: entry.id,
    family: entry.family,
    cost: entry.cost,
    context: entry.limit.context,
    tools: entry.capabilities.tools,
    input: entry.capabilities.input,
    status: entry.status,
    enabled: entry.enabled,
    released: entry.time.released,
    reasoningField: entry.compatibility?.reasoningField,
    variantSettings: entry.variants?.map((variant: any) => variant.settings) ?? [],
  })),
)

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.MODEL_SWITCHER_CONFIG
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

function writeConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "model-switcher-test-"))
  tempDirs.push(dir)
  const file = join(dir, "model-switcher.json")
  writeFileSync(file, JSON.stringify(config))
  process.env.MODEL_SWITCHER_CONFIG = file
  return file
}

function makeCtx(customCatalog: any[] = catalog()) {
  const added: any[] = []
  const calls = {
    switchModel: [] as any[],
    switchAgent: [] as any[],
    prompt: [] as any[],
    context: [] as any[],
  }
  const storage = new Map<string, unknown>()
  let current: any
  const ctx: any = {
    model: { list: async () => ({ location: {}, data: customCatalog }) },
    agent: { list: async () => ({ location: {}, data: [{ id: "build" }, { id: "plan" }] }) },
    command: { transform: (callback: any) => callback({ add: (definition: any) => added.push(definition) }) },
    event: { subscribe: async function* () {} },
    session: {
      get: async () => (current ? { model: current } : {}),
      switchModel: async (input: any) => {
        calls.switchModel.push(input)
        current = input.model
      },
      switchAgent: async (input: any) => void calls.switchAgent.push(input),
      prompt: async (input: any) => void calls.prompt.push(input),
      context: async () => calls.context,
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      remove: async (key: string) => void storage.delete(key),
    },
  }
  return { ctx, added, calls, storage, setCurrent: (value: any) => (current = value) }
}

async function setup(config?: unknown, customCatalog?: any[]) {
  const file = writeConfig(config ?? {})
  process.env.MODEL_SWITCHER_CONFIG = file
  const harness = makeCtx(customCatalog)
  const cleanup = await (plugin as any).setup(harness.ctx)
  return { ...harness, cleanup }
}

function runtimeFor(ctx: any, pairs: any[] = []) {
  return {
    ctx,
    defaults,
    preference,
    pairs,
    commandNames: [] as string[],
    fallbackBusy: new Set<string>(),
    lastFailure: new Map<string, { key: string; at: number }>(),
    stepModels: new Map<string, { providerID: string; id: string }>(),
  }
}

const find = (added: any[], name: string) => added.find((definition) => definition.name === name)
const names = (added: any[]) => added.map((definition) => definition.name)
const refs = (models: any[]) => models.map((entry) => `${entry.providerID}/${entry.id}`)

describe("version", () => {
  test("VERSION matches package.json", async () => {
    const pkg = (await Bun.file(new URL("./package.json", import.meta.url)).json()) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})

describe("parseRef", () => {
  test("parses a provider and model", () => {
    expect(parseRef("opencode/gpt-5")).toEqual({ providerID: "opencode", id: "gpt-5" })
  })

  test("keeps slashes inside the model", () => {
    expect(parseRef("openrouter/anthropic/claude")).toEqual({ providerID: "openrouter", id: "anthropic/claude" })
  })

  test("parses a variant", () => {
    expect(parseRef("a/b#max")).toEqual({ providerID: "a", id: "b", variant: "max" })
  })

  test("rejects bad refs", () => {
    expect(parseRef("a/")).toBeUndefined()
    expect(parseRef("/b")).toBeUndefined()
    expect(parseRef("ab")).toBeUndefined()
    expect(parseRef("a/b#v#w")).toBeUndefined()
  })
})

describe("isFree and isPaid", () => {
  test("zero tiers are free", () => {
    expect(isFree([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])).toBe(true)
    expect(isPaid([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])).toBe(false)
  })

  test("any positive value means paid", () => {
    expect(isFree([{ input: 0, output: 0.1 }])).toBe(false)
    expect(isPaid([{ input: 0, output: 0.1 }])).toBe(true)
    expect(isFree([{ input: 0, output: 0, cache: { read: 0.5, write: 0 } }])).toBe(false)
  })

  test("an empty or missing cost array is unknown, not free", () => {
    expect(isFree([])).toBe(false)
    expect(isFree(undefined)).toBe(false)
    expect(isPaid([])).toBe(false)
    expect(blendedCost([])).toBeUndefined()
  })
})

describe("isThinking", () => {
  test("a reasoning field marks a model", () => {
    expect(isThinking({ reasoningField: "reasoning_content", variantSettings: [] })).toBe(true)
  })

  test("thinking or effort variants mark a model", () => {
    expect(isThinking({ variantSettings: [{ thinkingConfig: { thinkingLevel: "high" } }] })).toBe(true)
    expect(isThinking({ variantSettings: [{ reasoningEffort: "low" }] })).toBe(true)
  })

  test("a model without either is not a reasoning model", () => {
    expect(isThinking({ variantSettings: [] })).toBe(false)
  })
})

describe("matchesFilter", () => {
  test("free selects only zero-cost tool models", () => {
    const result = catalog().filter((entry) => matchesFilter(record(entry), { free: true }, defaults))
    expect(refs(result)).toEqual(["opencode/mimo-free", "opencode/nemotron-free", "zai-coding-plan/glm-4.7", "nvidia/nvidia-nemotron"])
  })

  test("cheap selects paid models only", () => {
    const result = catalog().filter((entry) => matchesFilter(record(entry), { cheap: true }, defaults))
    expect(refs(result)).toContain("opencode/glm-5.3-flash")
    expect(refs(result)).toContain("opencode/kimi-k3")
    expect(refs(result)).not.toContain("opencode/mimo-free")
    expect(refs(result)).not.toContain("opencode/unknown-cost")
  })

  test("think, vision and long narrow by catalog metadata", () => {
    const thinking = catalog().filter((entry) => matchesFilter(record(entry), { think: true }, defaults))
    expect(refs(thinking)).toEqual(["opencode/nemotron-free", "opencode/kimi-k3", "opencode/muse-spark"])

    const vision = catalog().filter((entry) => matchesFilter(record(entry), { vision: true }, defaults))
    expect(refs(vision)).toEqual(["opencode/muse-spark"])

    const long = catalog().filter((entry) => matchesFilter(record(entry), { long: true }, defaults))
    expect(refs(long)).toEqual(["opencode/nemotron-free"])

    const explicit = catalog().filter((entry) => matchesFilter(record(entry), { long: 500000 }, defaults))
    expect(refs(explicit)).toEqual(["opencode/nemotron-free"])
  })

  test("provider and family match by id and prefix", () => {
    const provider = catalog().filter((entry) => matchesFilter(record(entry), { provider: "zai-coding-plan" }, defaults))
    expect(refs(provider)).toEqual(["zai-coding-plan/glm-4.7"])

    const family = catalog().filter((entry) => matchesFilter(record(entry), { family: "glm" }, defaults))
    expect(refs(family)).toEqual(["opencode/glm-5.3-flash", "zai-coding-plan/glm-4.7"])
  })

  test("never selects models without tools, beta models, or disabled models", () => {
    const all = catalog().filter((entry) => matchesFilter(record(entry), {}, defaults))
    expect(refs(all)).not.toContain("opencode/no-tools")
    expect(refs(all)).not.toContain("opencode/beta-model")
    expect(refs(all)).not.toContain("opencode/disabled-model")
  })
})

describe("rankModels", () => {
  test("cheapest first, free before paid, unknown cost last", () => {
    const result = rankModels(catalog().map(record), "cheapest", defaults)
    const order = refs(result)
    expect(order.indexOf("opencode/mimo-free")).toBeLessThan(order.indexOf("opencode/glm-5.3-flash"))
    expect(order.indexOf("opencode/glm-5.3-flash")).toBeLessThan(order.indexOf("opencode/kimi-k3"))
    expect(order.indexOf("opencode/kimi-k3")).toBeLessThan(order.indexOf("opencode/unknown-cost"))
  })

  test("new first and capped by the window", () => {
    const result = rankModels(catalog().map(record), "new", { ...defaults, new: 2 })
    expect(refs(result)).toEqual(["opencode/mimo-free", "opencode/nemotron-free"])
  })

  test("variants first: six before one before none, price as tie-break", () => {
    const result = rankModels(catalog().map(record), "variants", defaults)
    const order = refs(result)
    expect(order[0]).toBe("opencode/muse-spark")
    expect(order[1]).toBe("opencode/kimi-k3")
    expect(order.indexOf("opencode/kimi-k3")).toBeLessThan(order.indexOf("opencode/mimo-free"))
    expect(order.indexOf("opencode/mimo-free")).toBeLessThan(order.indexOf("opencode/unknown-cost"))
  })
})

describe("resolveModels", () => {
  test("walks the provider preference order", () => {
    const result = resolveModels(catalog().map(record), { free: true }, "cheapest", preference, defaults)
    expect(refs(result.models)).toEqual(["opencode/mimo-free", "opencode/nemotron-free", "zai-coding-plan/glm-4.7"])
    expect(result.fellBack).toBe(false)
  })

  test("an explicit provider filter beats the preference order", () => {
    const result = resolveModels(catalog().map(record), { provider: "nvidia" }, "cheapest", preference, defaults)
    expect(refs(result.models)).toEqual(["nvidia/nvidia-nemotron"])
  })

  test("all ignores the preference order", () => {
    const result = resolveModels(catalog().map(record), { free: true, all: true }, "cheapest", preference, defaults)
    expect(refs(result.models)[0]).toBe("opencode/mimo-free")
    expect(refs(result.models)).toContain("nvidia/nvidia-nemotron")
  })

  test("reports a fallback when no preferred provider matches", () => {
    const result = resolveModels(catalog().map(record), { free: true }, "cheapest", ["fireworks-ai"], defaults)
    expect(result.fellBack).toBe(true)
    expect(result.models.length).toBeGreaterThan(0)
  })

  test("the new window fills from the preferred providers, not before them", () => {
    const result = resolveModels(catalog().map(record), { new: true }, "new", preference, { ...defaults, new: 3 })
    expect(refs(result.models)).toEqual(["opencode/mimo-free", "opencode/nemotron-free", "opencode/deepseek-v4-flash"])
    expect(result.fellBack).toBe(false)
  })
})

describe("parseCommandArgs", () => {
  test("parses filters, list and use", () => {
    expect(parseCommandArgs("free nvidia", vocab).filter).toEqual({ free: true, provider: "nvidia" })
    expect(parseCommandArgs("list", vocab).action).toBe("list")
    expect(parseCommandArgs("use 3", vocab)).toMatchObject({ action: "use", use: 3 })
  })

  test("accepts case-insensitive providers and bare families", () => {
    expect(parseCommandArgs("NVIDIA", vocab).filter).toEqual({ provider: "nvidia" })
    expect(parseCommandArgs("muse", vocab).filter).toEqual({ family: "muse" })
    expect(parseCommandArgs("family:deepseek", vocab).filter).toEqual({ family: "deepseek" })
  })

  test("reports unknown tokens", () => {
    expect(parseCommandArgs("banana", vocab).unknown).toEqual(["banana"])
  })

  test("rejects malformed use and combined actions", () => {
    expect(parseCommandArgs("use", vocab).conflict).toContain("number")
    expect(parseCommandArgs("use 2 nvidia", vocab).conflict).toContain("only a number")
    expect(parseCommandArgs("use 2 list", vocab).conflict).toContain("cannot be combined")
  })

  test("help returns the help text as the conflict", () => {
    expect(parseCommandArgs("help", vocab).conflict).toBe(HELP_TEXT)
  })
})

describe("config normalization", () => {
  test("commands keep the fields we understand", () => {
    expect(
      normalizeCommand({
        description: "d",
        model: "a/b",
        models: ["a/b", "c/d"],
        agent: "plan",
        disabled: true,
        sort: "new",
        filter: { free: true, long: 100000, junk: true },
        mystery: 1,
      }),
    ).toEqual({
      description: "d",
      model: "a/b",
      models: ["a/b", "c/d"],
      agent: "plan",
      disabled: true,
      sort: "new",
      filter: { free: true, long: 100000 },
    })
  })

  test("filters reject wrong types and empty objects", () => {
    expect(normalizeFilter({ free: "yes" })).toBeUndefined()
    expect(normalizeFilter({ long: -1 })).toBeUndefined()
    expect(normalizeFilter({ provider: "" })).toBeUndefined()
    expect(normalizeFilter({ provider: "nvidia", family: "muse" })).toEqual({ provider: "nvidia", family: "muse" })
  })

  test("pairs need both sides", () => {
    expect(normalizePair({ primary: "a/b" })).toBeUndefined()
    expect(normalizePair({ primary: "a/b", fallback: { cheap: true }, retry: true })).toMatchObject({
      primary: { ref: "a/b" },
      fallback: { filter: { cheap: true } },
      retry: true,
      disabled: false,
    })
  })

  test("defaults accept providers, long and new", () => {
    expect(normalizeDefaults({ providers: ["a", " b ", ""], long: 200000, new: 0, list: 10 })).toEqual({
      providers: ["a", "b"],
      long: 200000,
      list: 10,
    })
  })

  test("loadUserCommands reads the new shape and ignores junk", async () => {
    const file = writeConfig({
      defaults: { providers: ["a"] },
      commands: { custom: { filter: { free: true } }, broken: "nope" },
      pairs: { zen: { primary: "a/b", fallback: "a/c" }, broken: {} },
    })
    const loaded = await loadUserCommands(file)
    expect(loaded.defaults).toEqual({ providers: ["a"] })
    expect(loaded.commands?.custom.filter).toEqual({ free: true })
    expect(loaded.commands?.broken).toBeUndefined()
    expect(loaded.pairs?.zen).toMatchObject({
      primary: { ref: "a/b" },
      fallback: { ref: "a/c" },
      retry: false,
      disabled: false,
    })
    expect(loaded.pairs?.broken).toBeUndefined()
  })
})

describe("setup", () => {
  test("registers defaults, config commands, pair commands and /model", async () => {
    const { added, cleanup } = await setup({
      commands: { ds: { filter: { provider: "deepseek" } } },
      pairs: { zen: { primary: { free: true }, fallback: { cheap: true } } },
    })
    cleanup?.()
    const registered = names(added)
    for (const name of ["free", "cheap", "think", "vision", "long", "new", "muse", "glm", "nvid", "ds", "zen", "model"]) {
      expect(registered).toContain(name)
    }
  })

  test("disabled commands are not registered", async () => {
    const { added, cleanup } = await setup({ commands: { nvid: { disabled: true } } })
    cleanup?.()
    expect(names(added)).not.toContain("nvid")
  })

  test("a pair cannot shadow a command", async () => {
    const { added, cleanup } = await setup({
      commands: { zen: { filter: { free: true } } },
      pairs: { zen: { primary: "opencode/mimo-free", fallback: "opencode/glm-5.3-flash" } },
    })
    cleanup?.()
    expect(names(added).filter((name) => name === "zen")).toHaveLength(1)
    const zen = find(added, "zen")
    expect(zen.description).not.toContain("fall back on provider errors")
  })
})

describe("command execution", () => {
  test("/free cycles to the first free model and remembers the position", async () => {
    const { added, calls, storage, cleanup } = await setup()
    cleanup?.()
    await find(added, "free").execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })
    expect(calls.switchModel).toHaveLength(1)
    expect(calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "mimo-free" })
    expect(storage.get("cycle/free/ses_1")).toBe("opencode/mimo-free")
    await find(added, "free").execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })
    expect(calls.switchModel[1].model).toEqual({ providerID: "opencode", id: "nemotron-free" })
  })

  test("/free list shows numbered models and stores them for use", async () => {
    const { added, calls, storage, cleanup } = await setup()
    cleanup?.()
    const list = find(added, "free")
    await expect(list.execute({ sessionID: "ses_1", prompt: { text: "list" }, delivery: "steer" })).rejects.toThrow(
      /Switch with \/free use N/,
    )
    expect(storage.get("list/free/ses_1")).toEqual([
      "opencode/mimo-free",
      "opencode/nemotron-free",
      "zai-coding-plan/glm-4.7",
    ])
    await list.execute({ sessionID: "ses_1", prompt: { text: "use 1" }, delivery: "steer" })
    expect(calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "mimo-free" })
  })

  test("filters narrow a group and unknown tokens fail loudly", async () => {
    const { added, calls, cleanup } = await setup()
    cleanup?.()
    const free = find(added, "free")
    await free.execute({ sessionID: "ses_1", prompt: { text: "nvidia" }, delivery: "steer" })
    expect(calls.switchModel[0].model).toEqual({ providerID: "nvidia", id: "nvidia-nemotron" })
    await expect(free.execute({ sessionID: "ses_1", prompt: { text: "banana" }, delivery: "steer" })).rejects.toThrow(
      /unknown filter/,
    )
  })

  test("/model help, status and direct refs", async () => {
    const { added, calls, cleanup } = await setup()
    cleanup?.()
    const modelCommand = find(added, "model")
    await expect(modelCommand.execute({ sessionID: "ses_1", prompt: { text: "help" }, delivery: "steer" })).rejects.toThrow(
      /built-in groups/i,
    )
    await expect(modelCommand.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })).rejects.toThrow(
      /Model: unknown/,
    )
    await modelCommand.execute({
      sessionID: "ses_1",
      prompt: { text: "opencode/glm-5.3-flash" },
      delivery: "steer",
    })
    expect(calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "glm-5.3-flash" })
  })

  test("a pinned command always picks its model and can switch the agent", async () => {
    const { added, calls, cleanup } = await setup({
      commands: { review: { model: "opencode/kimi-k3", agent: "plan" } },
    })
    cleanup?.()
    await find(added, "review").execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })
    expect(calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "kimi-k3" })
    expect(calls.switchAgent[0]).toEqual({ sessionID: "ses_1", agent: "plan" })
  })

  test("an unknown pinned model fails before switching", async () => {
    const { added, calls, cleanup } = await setup({ commands: { gone: { model: "opencode/missing" } } })
    cleanup?.()
    await expect(find(added, "gone").execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })).rejects.toThrow(
      /not in the model catalog/,
    )
    expect(calls.switchModel).toHaveLength(0)
  })
})

describe("pairs", () => {
  test("a pair command cycles its primary side", async () => {
    const { added, calls, cleanup } = await setup({
      pairs: { zen: { primary: { free: true }, fallback: { cheap: true } } },
    })
    cleanup?.()
    await find(added, "zen").execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })
    expect(calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "mimo-free" })
  })

  test("a provider error on a primary switches to the fallback", async () => {
    const harness = makeCtx()
    const runtime = runtimeFor(harness.ctx, [
      { name: "zen", primary: { filter: { free: true } }, fallback: { filter: { cheap: true } }, retry: false, disabled: false },
    ])
    harness.setCurrent({ providerID: "opencode", id: "mimo-free" })
    const handled = await handleSessionError(runtime, {
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { type: "provider.rate-limit", message: "429", status: 429 } },
    })
    expect(handled).toBe(true)
    expect(harness.calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "deepseek-v4-flash" })
  })

  test("a request-shape error still falls back, an overflow does not", async () => {
    const harness = makeCtx()
    const runtime = runtimeFor(harness.ctx, [
      { name: "spark", primary: { ref: "opencode/mimo-free" }, fallback: { ref: "opencode/glm-5.3-flash" }, retry: false, disabled: false },
    ])
    harness.setCurrent({ providerID: "opencode", id: "mimo-free" })
    const handled = await handleSessionError(runtime, {
      type: "session.step.failed",
      data: { sessionID: "ses_1", error: { type: "provider.invalid-request", message: "property 'prompt_cache_key' is unsupported", status: 400 } },
    })
    expect(handled).toBe(true)
    expect(harness.calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "glm-5.3-flash" })

    const overflow = await handleSessionError(runtime, {
      type: "session.step.failed",
      data: { sessionID: "ses_2", error: { type: "provider.invalid-request", message: "Prompt is too long: exceeds the maximum context length" } },
    })
    expect(overflow).toBe(false)
    expect(harness.calls.switchModel).toHaveLength(1)
  })

  test("one failure reported twice switches once", async () => {
    const harness = makeCtx()
    const runtime = runtimeFor(harness.ctx, [
      { name: "probe", primary: { ref: "groq/llama" }, fallback: { ref: "opencode/glm-5.3-flash" }, retry: false, disabled: false },
    ])
    rememberStep(runtime, { data: { sessionID: "ses_1", model: { providerID: "groq", id: "llama" } } })
    const error = { type: "provider.invalid-request", message: "property 'prompt_cache_key' is unsupported", status: 400 }
    const first = await handleSessionError(runtime, { type: "session.step.failed", data: { sessionID: "ses_1", error } })
    const second = await handleSessionError(runtime, { type: "session.execution.failed", data: { sessionID: "ses_1", error } })
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(harness.calls.switchModel).toHaveLength(1)
  })

  test("the failing step model wins over the current session model", async () => {
    const harness = makeCtx()
    const runtime = runtimeFor(harness.ctx, [
      { name: "probe", primary: { ref: "groq/llama" }, fallback: { ref: "opencode/glm-5.3-flash" }, retry: false, disabled: false },
    ])
    // The session already moved on to a free OpenCode model; the failure came
    // from the Groq step that just failed.
    harness.setCurrent({ providerID: "opencode", id: "mimo-free" })
    rememberStep(runtime, { data: { sessionID: "ses_1", model: { providerID: "groq", id: "llama" } } })
    const handled = await handleSessionError(runtime, {
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { type: "provider.error", message: "boom" } },
    })
    expect(handled).toBe(true)
    expect(harness.calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "glm-5.3-flash" })
  })

  test("aborts, content filters, bad output and legacy names never fall back", async () => {
    const harness = makeCtx()
    const runtime = runtimeFor(harness.ctx, [
      { name: "zen", primary: { filter: { free: true } }, fallback: { filter: { cheap: true } }, retry: false, disabled: false },
    ])
    harness.setCurrent({ providerID: "opencode", id: "mimo-free" })
    for (const error of [
      { type: "aborted" },
      { type: "provider.content-filter" },
      { type: "provider.invalid-output" },
      { name: "MessageAbortedError" },
      { name: "ContextOverflowError" },
      { name: "MessageOutputLengthError" },
    ]) {
      expect(classifyError(error)).toBe("ignore")
      const handled = await handleSessionError(runtime, { type: "session.execution.failed", data: { sessionID: "ses_1", error } })
      expect(handled).toBe(false)
    }
    expect(harness.calls.switchModel).toHaveLength(0)
  })

  test("a session running a model outside the pair is untouched", async () => {
    const harness = makeCtx()
    const runtime = runtimeFor(harness.ctx, [
      { name: "zen", primary: { ref: "opencode/mimo-free" }, fallback: { ref: "opencode/glm-5.3-flash" }, retry: false, disabled: false },
    ])
    harness.setCurrent({ providerID: "opencode", id: "kimi-k3" })
    const handled = await handleSessionError(runtime, {
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { type: "provider.auth", message: "no key" } },
    })
    expect(handled).toBe(false)
    expect(harness.calls.switchModel).toHaveLength(0)
  })

  test("a ref primary matches the session model even with a variant", async () => {
    const harness = makeCtx()
    const runtime = runtimeFor(harness.ctx, [
      { name: "spark", primary: { ref: "opencode/mimo-free" }, fallback: { ref: "opencode/glm-5.3-flash" }, retry: false, disabled: false },
    ])
    harness.setCurrent({ providerID: "opencode", id: "mimo-free", variant: "default" })
    const handled = await handleSessionError(runtime, {
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { type: "provider.error" } },
    })
    expect(handled).toBe(true)
    expect(harness.calls.switchModel[0].model).toEqual({ providerID: "opencode", id: "glm-5.3-flash" })
  })

  test("retry resends the last prompt only when nothing followed it", async () => {
    const harness = makeCtx()
    const runtime = runtimeFor(harness.ctx, [
      { name: "zen", primary: { ref: "opencode/mimo-free" }, fallback: { ref: "opencode/glm-5.3-flash" }, retry: true, disabled: false },
    ])
    harness.setCurrent({ providerID: "opencode", id: "mimo-free" })
    harness.calls.context.push({ type: "user", text: "fix the tests" })
    await handleSessionError(runtime, {
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { type: "provider.error", message: "boom" } },
    })
    expect(harness.calls.prompt[0]).toEqual({ sessionID: "ses_1", text: "fix the tests" })

    harness.calls.context.length = 0
    harness.calls.context.push({ type: "user", text: "fix the tests" }, { type: "assistant", text: "working" })
    harness.calls.switchModel.length = 0
    harness.setCurrent({ providerID: "opencode", id: "mimo-free" })
    await handleSessionError(runtime, {
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { type: "provider.error", message: "boom again" } },
    })
    expect(harness.calls.prompt).toHaveLength(1)
  })
})

describe("formatting", () => {
  test("describeModel shows the ref, price, context and capabilities", () => {
    const free = describeModel({
      providerID: "opencode",
      id: "mimo-free",
      name: "Mimo Free",
      cost: [{ input: 0, output: 0 }],
      context: 200000,
      tools: true,
      input: ["text", "image"],
      enabled: true,
      released: 0,
      variantSettings: [],
    })
    expect(free).toContain("opencode/mimo-free")
    expect(free).toContain("free")
    expect(free).toContain("ctx 200k")
    expect(free).toContain("image")
  })
})

function record(entry: any) {
  return {
    providerID: entry.providerID,
    id: entry.id,
    name: entry.name,
    family: entry.family,
    cost: entry.cost,
    context: entry.limit.context,
    tools: entry.capabilities.tools,
    input: entry.capabilities.input,
    status: entry.status,
    enabled: entry.enabled,
    released: entry.time.released,
    reasoningField: entry.compatibility?.reasoningField,
    variantSettings: entry.variants?.map((variant: any) => variant.settings) ?? [],
  }
}
