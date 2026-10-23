// The host provides @opencode/plugin at runtime. Tests run outside OpenCode,
// so stub the only member this plugin uses.
import { mock } from "bun:test"

mock.module("@opencode/plugin", () => ({
  Plugin: { define: <T>(plugin: T): T => plugin },
}))
