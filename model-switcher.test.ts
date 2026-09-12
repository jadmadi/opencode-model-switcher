import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { missingFrom, normalizeConfig, parseRef, parseRefs, refsFor } from "./model-switcher.ts"

function toModelInfo(key: string) {
  const [providerID, ...rest] = key.split("/")
  return { providerID, id: rest.join("/") }
}

function makeCtx(catalogKeys: string[], agentIDs: string[] = ["build", "plan"]) {
  let data = catalogKeys.map(toModelInfo)
  const agents = agentIDs.map((id) => ({ id, name: id }))
  const added: any[] = []
  const calls = {
    switchModel: [] as any[],
    switchAgent: [] as any[],
    prompt: [] as any[],
  }
  const ctx: any = {
    catalog: { model: { list: async () => ({ location: {}, data }) } },
    agent: { list: async () => ({ location: {}, data: agents }) },
    command: { transform: (callback: any) => callback({ add: (definition: any) => added.push(definition) }) },
    session: {
      switchModel: async (input: any) => void calls.switchModel.push(input),
      switchAgent: async (input: any) => void calls.switchAgent.push(input),
      prompt: async (input: any) => void calls.prompt.push(input),
      get: async () => ({}),
    },
    storage: { get: async () => undefined, set: async () => undefined },
  }
  return { ctx, added, calls, setCatalog: (keys: string[]) => void (data = keys.map(toModelInfo)) }
}

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.MODEL_SWITCHER_CONFIG
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

async function setup(config?: unknown, catalogKeys: string[] = [], agentIDs?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "model-switcher-test-"))
  tempDirs.push(dir)
  const file = join(dir, "model-switcher.json")
  if (config !== undefined) writeFileSync(file, JSON.stringify(config))
  process.env.MODEL_SWITCHER_CONFIG = file
  const harness = makeCtx(catalogKeys, agentIDs)
  await (plugin as any).setup(harness.ctx)
  return harness
}

const names = (added: any[]) => added.map((definition) => definition.name)

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

  test("treats a trailing hash as no variant", () => {
    expect(parseRef("a/b#")).toEqual({ providerID: "a", id: "b" })
  })

  test("rejects a second hash", () => {
    expect(parseRef("a/b#v#w")).toBeUndefined()
  })

  test("rejects bad refs", () => {
    expect(parseRef("a/")).toBeUndefined()
    expect(parseRef("/b")).toBeUndefined()
    expect(parseRef("ab")).toBeUndefined()
    expect(parseRef("")).toBeUndefined()
  })
})

describe("normalizeConfig", () => {
  test("rejects non-objects", () => {
    expect(normalizeConfig(undefined)).toBeUndefined()
    expect(normalizeConfig(42)).toBeUndefined()
    expect(normalizeConfig([])).toBeUndefined()
    expect(normalizeConfig(null)).toBeUndefined()
  })

  test("keeps known fields", () => {
    expect(normalizeConfig({ description: "x", model: "a/b", agent: "plan", disabled: true })).toEqual({
      description: "x",
      model: "a/b",
      agent: "plan",
      disabled: true,
    })
  })

  test("drops fields with the wrong type", () => {
    expect(normalizeConfig({ model: 42, models: "a/b", disabled: "yes" })).toEqual({})
  })

  test("accepts a list of strings", () => {
    expect(normalizeConfig({ models: ["a/b", "c/d"] })).toEqual({ models: ["a/b", "c/d"] })
    expect(normalizeConfig({ models: ["a/b", 3] })).toEqual({})
  })
})

describe("refsFor", () => {
  test("prefers models", () => {
    expect(refsFor({ models: ["a/b"], model: "c/d" })).toEqual(["a/b"])
  })

  test("falls back to model", () => {
    expect(refsFor({ model: "c/d" })).toEqual(["c/d"])
  })

  test("returns nothing when empty", () => {
    expect(refsFor({ models: [] })).toEqual([])
    expect(refsFor({})).toEqual([])
  })
})

describe("parseRefs", () => {
  test("keeps valid refs and drops bad ones", () => {
    expect(parseRefs("x", ["a/b", "bad", "c/d"])).toEqual([
      { providerID: "a", id: "b" },
      { providerID: "c", id: "d" },
    ])
  })
})

describe("missingFrom", () => {
  test("reports nothing without a catalog", () => {
    expect(missingFrom([{ providerID: "a", id: "b" }], undefined)).toEqual([])
  })

  test("finds models that are not in the catalog", () => {
    const known = new Set(["a/b"])
    expect(missingFrom([{ providerID: "a", id: "b" }, { providerID: "c", id: "d" }], known)).toEqual([
      { providerID: "c", id: "d" },
    ])
  })
})

describe("setup", () => {
  test("registers the defaults without a config file", async () => {
    const { added } = await setup()
    expect(names(added)).toEqual(["ds-go", "ds", "zai", "oc-zen"])
  })

  test("adds user commands", async () => {
    const { added } = await setup({ commands: { "oc-thinking": { models: ["opencode/claude-opus-4-8"] } } })
    expect(names(added)).toContain("oc-thinking")
    expect(names(added)).toContain("ds-go")
  })

  test("merges fields over a default", async () => {
    const { added } = await setup({ commands: { "ds-go": { description: "Custom" } } })
    const dsGo = added.find((definition) => definition.name === "ds-go")
    expect(dsGo.description).toBe("Custom")
  })

  test("keeps good entries when a bad one is present", async () => {
    const { added } = await setup({ commands: { good: { model: "a/b" }, bad: 42, worse: { models: "a/b" } } })
    expect(names(added)).toContain("good")
    expect(names(added)).not.toContain("bad")
    expect(names(added)).not.toContain("worse")
  })

  test("removes a disabled default", async () => {
    const { added } = await setup({ commands: { "oc-zen": { disabled: true } } })
    expect(names(added)).not.toContain("oc-zen")
    expect(names(added)).toContain("ds-go")
  })

  test("skips a command with no usable models", async () => {
    const { added } = await setup({ commands: { empty: { description: "no model" } } })
    expect(names(added)).not.toContain("empty")
  })

  test("registers a command whose model is missing from the catalog", async () => {
    const { added } = await setup({ commands: { later: { model: "a/later" } } }, ["a/other"])
    expect(names(added)).toContain("later")
  })
})

describe("execute", () => {
  test("switches the model and forwards the prompt", async () => {
    const { added, calls } = await setup(undefined, ["opencode-go/deepseek-v4.1-flash"])
    const command = added.find((definition) => definition.name === "ds-go")
    await command.execute({ sessionID: "ses_1", prompt: { text: "fix it" }, delivery: "steer" })
    expect(calls.switchModel).toEqual([
      { sessionID: "ses_1", model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } },
    ])
    expect(calls.switchAgent).toEqual([])
    expect(calls.prompt).toHaveLength(1)
  })

  test("does not send an empty prompt", async () => {
    const { added, calls } = await setup(undefined, ["opencode-go/deepseek-v4.1-flash"])
    const command = added.find((definition) => definition.name === "ds-go")
    await command.execute({ sessionID: "ses_1", prompt: { text: "  " }, delivery: "steer" })
    expect(calls.switchModel).toHaveLength(1)
    expect(calls.prompt).toEqual([])
  })

  test("switches the agent only when configured", async () => {
    const { added, calls } = await setup(
      { commands: { mine: { model: "opencode/gpt-5", agent: "plan" } } },
      ["opencode/gpt-5"],
    )
    const command = added.find((definition) => definition.name === "mine")
    await command.execute({ sessionID: "ses_1", prompt: { text: "hi" }, delivery: "steer" })
    expect(calls.switchAgent).toEqual([{ sessionID: "ses_1", agent: "plan" }])
  })

  test("fails loudly when the model is gone and does not switch", async () => {
    const harness = await setup({ commands: { later: { model: "a/later" } } }, ["a/later"])
    harness.setCatalog(["a/other"])
    const command = harness.added.find((definition) => definition.name === "later")
    await expect(
      command.execute({ sessionID: "ses_1", prompt: { text: "hi" }, delivery: "steer" }),
    ).rejects.toThrow(/not available/)
    expect(harness.calls.switchModel).toEqual([])
  })

  test("fails when the configured agent is not available", async () => {
    const { added, calls } = await setup(
      { commands: { mine: { model: "opencode/gpt-5", agent: "ghost" } } },
      ["opencode/gpt-5"],
    )
    const command = added.find((definition) => definition.name === "mine")
    await expect(
      command.execute({ sessionID: "ses_1", prompt: { text: "hi" }, delivery: "steer" }),
    ).rejects.toThrow(/agent "ghost" is not available/)
    expect(calls.switchModel).toEqual([])
  })
})
