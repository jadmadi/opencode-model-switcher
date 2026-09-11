interface PluginDefinition {
  id: string
  setup: (ctx: any) => Promise<void> | void
}

interface ModelSwitch {
  description: string
  model: { providerID: string; id: string }
}

const SWITCHES: Record<string, ModelSwitch> = {
  "ds-go": {
    description: "Switch to DeepSeek via OpenCode Go",
    model: { providerID: "opencode-go", id: "deepseek-v4-flash" },
  },
  "ds": {
    description: "Switch to DeepSeek platform",
    model: { providerID: "deepseek", id: "deepseek-v4-flash" },
  },
  "zai": {
    description: "Switch to Z.AI GLM",
    model: { providerID: "zai-coding-plan", id: "glm-5.3" },
  },
}

const ZEN_FREE = [
  { providerID: "opencode", id: "nemotron-3-ultra-free" },
  { providerID: "opencode", id: "nemotron-3.5-lightning-free" },
  { providerID: "opencode", id: "muse-spark-1.3-contributor-free" },
  { providerID: "opencode", id: "muse-spark-1.2-contributor-free" },
  { providerID: "opencode", id: "mimo-v2.5-free" },
  { providerID: "opencode", id: "ling-3.0-flash-fin-free" },
]

const plugin: PluginDefinition = {
  id: "model-switcher",
  async setup(ctx) {
    await ctx.command.transform((editor: any) => {
      for (const [name, sw] of Object.entries(SWITCHES)) {
        editor.add({
          name,
          description: sw.description,
          execute: async ({ sessionID, prompt, delivery }: any) => {
            await ctx.session.switchModel({ sessionID, model: sw.model })
            await ctx.session.switchAgent({ sessionID, agent: "build" })
            if (prompt.text.trim()) {
              await ctx.session.prompt({ ...prompt, sessionID, delivery })
            }
          },
        })
      }
      editor.add({
        name: "oc-zen",
        description: "Cycle through OpenCode Zen free models",
        execute: async ({ sessionID, prompt, delivery }: any) => {
          const current = await ctx.storage.get(`oc-zen/${sessionID}`)
          const next = ((typeof current === "number" ? current : -1) + 1) % ZEN_FREE.length
          await ctx.storage.set(`oc-zen/${sessionID}`, next)
          await ctx.session.switchModel({ sessionID, model: ZEN_FREE[next] })
          await ctx.session.switchAgent({ sessionID, agent: "build" })
          if (prompt.text.trim()) {
            await ctx.session.prompt({ ...prompt, sessionID, delivery })
          }
        },
      })
    })
  },
}

export default plugin