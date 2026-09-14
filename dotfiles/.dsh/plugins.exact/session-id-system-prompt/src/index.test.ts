import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { apply } from "./index.ts";

function fakeAgent(sessionId: string): Agent {
  return { session: { id: sessionId } } as unknown as Agent;
}

describe("dsh session ID system prompt", () => {
  it("renders each session's own ID without shared state", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
      apply(ctx);
      const firstId = "session-first";
      const secondId = "session-second";
      const [firstAssembly, secondAssembly] = await Promise.all([
        ctx.systemPrompt.assemble({ agent: fakeAgent(firstId) }),
        ctx.systemPrompt.assemble({ agent: fakeAgent(secondId) }),
      ]);

      const firstPrompt = renderPrompt(firstAssembly);
      const secondPrompt = renderPrompt(secondAssembly);
      assert.equal(firstPrompt, `Current dsh session ID: ${JSON.stringify(firstId)}`);
      assert.equal(secondPrompt, `Current dsh session ID: ${JSON.stringify(secondId)}`);
      assert.ok(!firstPrompt.includes(secondId));
      assert.ok(!secondPrompt.includes(firstId));
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("renders an unsafe session ID as one JSON string", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
      apply(ctx);
      const sessionId = 'session-"quoted"\nnext {{unknown}}';
      const assembly = await ctx.systemPrompt.assemble({ agent: fakeAgent(sessionId) });
      const expectedPrompt =
        'Current dsh session ID: "session-\\"quoted\\"\\nnext \\u007b\\u007bunknown\\u007d\\u007d"';

      assert.equal(renderPrompt(assembly), expectedPrompt);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("omits the session ID for agent-less assembly and preserves existing sections", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
      ctx.systemPrompt.section({ name: "existing", order: 100, text: "Existing guidance." });
      apply(ctx);

      assert.equal(renderPrompt(await ctx.systemPrompt.assemble()), "Existing guidance.");
      assert.equal(
        renderPrompt(await ctx.systemPrompt.assemble({ agent: fakeAgent("session-agent") })),
        'Current dsh session ID: "session-agent"\n\nExisting guidance.',
      );
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
