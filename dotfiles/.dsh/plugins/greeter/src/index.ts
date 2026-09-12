/**
 * dotfiles-greeter — first dotfiles-managed DSH plugin (bundle form).
 *
 * Registers a `/hello` slash command. The user types `/hello <name>` in an
 * interactive composer and the settled text renders directly in the UI — no
 * model call involved, so the plugin wiring is easy to verify by hand.
 *
 * Types are structural subsets of the framework interfaces
 * (`@deepseek-ai/dsh-commands` `CommandDefinition`, `@deepseek-ai/cordis`
 * `Context.effect`) so this package needs no dependency installs; the loader
 * resolves the framework from the profile closure at runtime.
 */

/** Structural subset of the dsh-commands `CommandResult`. */
type GreeterCommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string };

/** Structural subset of the dsh-commands `CommandInvocation` used here. */
interface GreeterCommandInvocation {
  /** Exact text following the command name, including separator whitespace. */
  rawInput: string;
}

/** Disposer returned by effect bodies and by `register`. */
type Disposer = () => void;

/** Structural subset of the dsh-commands `CommandRuntime` registry. */
interface GreeterCommandRegistry {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string };
    handler(invocation: GreeterCommandInvocation): GreeterCommandResult | Promise<GreeterCommandResult>;
  }): Disposer;
}

/** Structural subset of the cordis `Context` used by this plugin. */
interface GreeterContext {
  commands: GreeterCommandRegistry;
  effect(execute: () => Generator<Disposer | Promise<void>, void, unknown>, label?: string): unknown;
}

export const name = 'greeter';
export const inject = ['commands'];

export function apply(ctx: GreeterContext) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'hello',
      description: 'Greet someone by name',
      input: { hint: '<name>' },
      handler({ rawInput }) {
        const name = rawInput.trim();
        if (!name) return { kind: 'error', text: 'Usage: /hello <name>' };
        return { kind: 'success', text: `Hello, ${name}! (from dotfiles-greeter)` };
      },
    });
  }, 'greeter /hello command');
}
