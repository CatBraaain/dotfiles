/**
 * dotfiles-greeter — first dotfiles-managed DSH plugin (bundle form).
 *
 * Registers a `say_hello` tool. The model calls `say_hello({ name })` and
 * receives a greeting line as the canonical string value.
 *
 * Types are structural subsets of the framework interfaces
 * (`@deepseek-ai/dsh-tools` `ToolDefinition`, `@deepseek-ai/dsh-llm`
 * `ContentBlock`) so this package needs no dependency installs; the loader
 * resolves the framework from the profile closure at runtime.
 */

/** Text content block as produced by `output.render`. */
type TextBlock = { type: 'text'; text: string };

/** Structural subset of the dsh-tools ToolDefinition for one tool. */
interface GreeterToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the model arguments. */
  parameters: Record<string, unknown>;
  output: {
    /** JSON Schema enforced against the canonical value. */
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): TextBlock[];
  };
  /** Returns the canonical value declared by `output.schema`. */
  execute(args: unknown): Promise<unknown>;
}

/** Structural subset of the `tools` service registry. */
interface ToolRegistry {
  register(definition: GreeterToolDefinition): () => void;
}

export const name = 'greeter';
export const inject = ['tools'];

export function apply(ctx: { tools: ToolRegistry }) {
  ctx.tools.register({
    name: 'say_hello',
    description: 'Greet someone by name. Returns a short greeting line.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the person to greet' },
      },
      required: ['name'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const { name } = args as { name: string };
      return `Hello, ${name}! (from dotfiles-greeter)`;
    },
  });
}
