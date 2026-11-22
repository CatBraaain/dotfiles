import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "../support/vscode";

test(
  "Controls only the global ticket dispatcher from the Sessions toolbar",
  { annotation: { type: "spec", description: "E2E-19" } },
  async ({ host }, testInfo) => {
    const ticket = join(host.directory, "bin/ticket");
    const ticketSource = resolve(__dirname, "../../../../../.agents/cli.exact/ticket/src/main.ts");
    execFileSync("bun", ["build", "--compile", ticketSource, "--outfile", ticket]);
    const home = host.env.HOME;
    const store = join(home, ".agents/tickets/alpha");
    mkdirSync(store, { recursive: true });
    mkdirSync(join(home, "projects/alpha"), { recursive: true });
    writeFileSync(join(store, "existing.md"), "---\nstatus: open\n---\n# Existing\n");
    mkdirSync(dirname(host.tmuxSocket), { recursive: true });
    host.tmux([
      "new-session",
      "-d",
      "-s",
      "handle_existing",
      "-e",
      "TICKET_DISPATCH_PROJECT=alpha",
      "-e",
      "TICKET_DISPATCH_ROLE=pi",
      "-e",
      "TICKET_DISPATCH_ID=existing",
      "sleep 600",
    ]);
    const listTmuxSessions = () =>
      host.tmux(["list-sessions", "-F", "#{session_name}"]).trim().split("\n");
    const ticketDispatch = (...args: string[]) =>
      execFileSync(ticket, ["dispatch", ...args], { cwd: home, env: host.env, encoding: "utf8" });

    const refresh = host.page
      .getByRole("button", { name: "Refresh Sessions", exact: true })
      .describe("Sessions refresh action");
    const start = host.page
      .getByRole("button", { name: "Start Ticket Dispatch (All Projects)", exact: true })
      .describe("Start ticket dispatch action");
    const stop = host.page
      .getByRole("button", {
        name: "Stop New Ticket Dispatch (Running Agents Continue)",
        exact: true,
      })
      .describe("Stop new ticket dispatch action");

    async function capture(name: string, filename: string): Promise<void> {
      const path = testInfo.outputPath(filename);
      await host.page.locator(".part.sidebar .composite.title").screenshot({ path });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }

    await test.step("Find the start action to the left of Refresh Sessions", async () => {
      await refresh.click();
      await expect(start).toBeVisible();
      await expect(start).toBeEnabled();
      await expect(start).toHaveClass(/codicon-debug-start/);
      await expect(stop).toHaveCount(0);
      await expect
        .poll(async () => {
          const [startBounds, refreshBounds] = await Promise.all([
            start.boundingBox(),
            refresh.boundingBox(),
          ]);
          return (
            startBounds !== null &&
            refreshBounds !== null &&
            startBounds.x + startBounds.width <= refreshBounds.x
          );
        })
        .toBe(true);
      await capture("Dispatch stopped", "dispatch-stopped.png");
    });

    await test.step("Start the global dispatcher", async () => {
      await start.press("Enter");
      await expect(stop).toBeEnabled();
      await expect(stop).toHaveClass(/codicon-debug-pause/);
      await expect(start).toHaveCount(0);
      await expect.poll(listTmuxSessions).toContain("ticket_dispatch_all");
      await capture("Dispatch running", "dispatch-running.png");
    });

    await test.step("Stop dispatch and keep the active ticket session alive", async () => {
      await stop.press("Enter");
      await expect(start).toBeEnabled();
      expect(listTmuxSessions()).not.toContain("ticket_dispatch_all");
      expect(listTmuxSessions()).toContain("handle_existing");
    });

    await test.step("Recheck an outdated start action without restarting an external dispatcher", async () => {
      ticketDispatch("start", "--all");
      const globalSessionId = () =>
        host.tmux(["display-message", "-p", "-t", "ticket_dispatch_all", "#{session_id}"]).trim();
      const originalSessionId = globalSessionId();
      expect(originalSessionId).toMatch(/^\$\d+$/);
      await start.click();
      await expect(stop).toBeEnabled();
      expect(globalSessionId()).toBe(originalSessionId);
      ticketDispatch("stop", "--all");
      await refresh.click();
      await expect(start).toBeEnabled();
    });

    await test.step("Report a project dispatcher conflict without stopping it", async () => {
      const projectSession = "ticket_dispatch_616c706861";
      host.tmux([
        "new-session",
        "-d",
        "-s",
        projectSession,
        "-e",
        "TICKET_DISPATCH_PROJECT=alpha",
        "-e",
        "TICKET_DISPATCH_ROLE=dispatcher",
        "sleep 600",
      ]);
      await start.click();
      await expect(
        host.page.getByRole("dialog", { name: /overlapping dispatcher already running/ }),
      ).toBeVisible();
      await expect(start).toBeEnabled();
      expect(listTmuxSessions()).toContain(projectSession);
      expect(listTmuxSessions()).not.toContain("ticket_dispatch_all");
    });

    await test.step("Disable dispatch when status is unavailable and recover with Refresh Sessions", async () => {
      const savedTicket = `${ticket}.real`;
      renameSync(ticket, savedTicket);
      writeFileSync(ticket, "#!/bin/sh\necho 'Fixture status unavailable' >&2\nexit 1\n", {
        mode: 0o700,
      });
      await refresh.click();
      await expect(start).toBeDisabled();
      await expect(
        host.page.getByRole("dialog", { name: /Fixture status unavailable/ }),
      ).toBeVisible();
      renameSync(savedTicket, ticket);
      await refresh.click();
      await expect(start).toBeEnabled();
    });
  },
);
