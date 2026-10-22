import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/vscode";
import type { VSCodeFixture } from "../support/vscode";

test.use({ trace: "on" });

const SCM_EVIDENCE_SCOPE =
  "A/B evidence covers visible repositories with Graph Auto only. Hidden repositories, fixed Graph selection and active repository pin remain unmet and were not executed in this run. Owner decision is pending (G1). This note does not resolve G1 or the real assistant response gap (G3).";

test("same-name main/worktree folders remain distinct and All exposes zero-active history", async ({
  host,
}, testInfo) => {
  await test.step("Read the full paths of the two project folders", async () => {
    const frame = await host.sessionFrame();
    await expect(
      frame.getByText(host.sessions.A.cwd, { exact: true }),
    ).toBeVisible();
    await expect(
      frame.getByText(host.sessions.B.cwd, { exact: true }),
    ).toBeVisible();
    await expect(
      frame.getByText(
        "No active sessions. Select All to browse saved sessions.",
        { exact: true },
      ),
    ).toBeVisible();
    await testInfo.attach("Distinct work folders", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
  });
  await test.step("Choose All in the inactive worktree group", async () => {
    const frame = await host.sessionFrame();
    const group = frame
      .locator("section.group")
      .filter({ has: frame.getByText(host.sessions.B.cwd, { exact: true }) });
    await group
      .locator('[data-mode="all"]')
      .describe("Worktree history")
      .click({ steps: 15 });
    await expect(
      frame
        .locator(`[data-session="${host.sessions.B.id}"]`)
        .describe("Saved inactive B session"),
    ).toBeVisible();
    await testInfo.attach("Inactive history", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
  });
});

test("A/B selection reuses real Pi terminals and follows the native diff and SCM repository", async ({
  host,
}, testInfo) => {
  testInfo.annotations.push({
    type: "SCM coverage limitation",
    description: SCM_EVIDENCE_SCOPE,
  });
  await testInfo.attach("SCM evidence scope and unmet conditions", {
    body: SCM_EVIDENCE_SCOPE,
    contentType: "text/plain",
  });
  const firstPids = new Map<string, number>();
  for (const key of ["A", "B", "A", "B"]) {
    await test.step(`Select ${key} and wait for its native diff`, async () => {
      await host.selectSession(key);
      await host.expectDiff(key);
      await testInfo.attach(`${key} diff`, {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    await test.step(`Observe ${key} SCM focus without changing settings`, async () => {
      await expect
        .poll(
          () =>
            host
              .snapshot()
              .repositories.find(
                (repository) => repository.root === host.sessions[key].cwd,
              )?.selected,
        )
        .toBe(true);
      await expect(
        host.page
          .locator(".statusbar-item")
          .filter({ hasText: key === "A" ? "fixture-a" : "fixture-b" })
          .first()
          .describe("Native branch indicator"),
      ).toBeVisible();
      await expect(
        host.page
          .getByRole("toolbar", { name: "Graph actions", exact: true })
          .getByRole("button", {
            name: key === "A" ? "fixture-a" : "fixture-b",
            exact: true,
          })
          .describe("Built-in Graph branch"),
      ).toBeVisible();
    });
    await test.step(`Check the real ${key} Pi process cwd and PID reuse`, async () => {
      await expect
        .poll(() =>
          host
            .piProcesses()
            .some((process) => process.cwd === host.sessions[key].cwd),
        )
        .toBe(true);
      const pi = host
        .piProcesses()
        .find((process) => process.cwd === host.sessions[key].cwd)!;
      const priorPid = firstPids.get(key);
      if (priorPid !== undefined) expect(pi.pid).toBe(priorPid);
      else firstPids.set(key, pi.pid);
      await testInfo.attach(`${key} real process evidence`, {
        body: JSON.stringify(host.piProcesses(), null, 2),
        contentType: "application/json",
      });
    });
    await test.step(`Read ${key} original session path and ID in the real Pi TUI`, async () => {
      await host.page
        .getByRole("tab", { name: `Fixture ${key}`, exact: true })
        .describe(`${key} Pi terminal`)
        .click({ steps: 15 });
      const terminalInput = host.page
        .getByRole("textbox", {
          name: new RegExp(`Terminal [0-9]+, Fixture ${key}`),
        })
        .describe("Pi command input");
      await terminalInput.pressSequentially("/session", { delay: 120 });
      await terminalInput.press("Enter");
      await expect
        .poll(async () =>
          (await host.page.locator("body").innerText()).replace(/\s/g, ""),
        )
        .toContain(host.sessions[key].session);
      await testInfo.attach(`${key} Pi session info`, {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
      expect(
        readFileSync(host.sessions[key].session, "utf8").startsWith(
          host.sessions[key].original,
        ),
      ).toBe(true);
      expect(host.gitState(host.sessions[key].cwd)).toBe(
        host.gitBefore[host.sessions[key].cwd],
      );
    });
  }
});

test("SCM hidden repositories, fixed Graph and active repository pin remain unmet: not executed, owner decision pending", async () => {
  test.skip(true, SCM_EVIDENCE_SCOPE);
});

test("SCM to Sessions round trips preserve the list without Refresh", async ({
  host,
}, testInfo) => {
  for (const key of ["B", "A", "B", "A"]) {
    await test.step(`Return from SCM and select ${key} without Refresh`, async () => {
      await host.selectSession(key);
      await host.expectDiff(key);
      const frame = await host.sessionFrame();
      await expect(frame.locator("section.group")).toHaveCount(4);
      await expect(
        frame.getByText(host.sessions.B.cwd, { exact: true }),
      ).toBeVisible();
      await testInfo.attach(`${key} list restored`, {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
  }
});

test("the editor at selection acceptance determines the changed file", async ({
  host,
}, testInfo) => {
  await test.step("Open the worktree preferred file in the native editor", async () => {
    await host.page.keyboard.press("Control+p");
    await host.page
      .locator(".quick-input-widget input")
      .describe("Quick Open file path")
      .pressSequentially(join(host.sessions.B.cwd, "z-preferred.txt"), {
        delay: 120,
      });
    await host.page.keyboard.press("Enter");
    await expect
      .poll(() => host.snapshot().activeEditor)
      .toBe(`file://${join(host.sessions.B.cwd, "z-preferred.txt")}`);
  });
  await test.step("Select B and wait for that file's active diff", async () => {
    await host.selectSession("B");
    await host.expectDiff("B", "z-preferred.txt");
    await testInfo.attach("Accepted editor diff", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
  });
});

test("single-root explicit folder addition survives extension host restart and reselection", async ({
  host,
}, testInfo) => {
  await test.step("Open an unregistered session without adding its folder", async () => {
    await host.selectSession("External");
    await expect(
      host.page
        .getByRole("button", { name: "Add folder to workspace", exact: true })
        .describe("Explicit add-folder action"),
    ).toBeVisible();
    expect(host.snapshot().folders).toEqual([host.sessions.A.cwd]);
    await testInfo.attach("Explicit consent required", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
  });
  const previousHostPid = host.snapshot().hostPid;
  await test.step("Explicitly add the folder and observe a new extension host", async () => {
    await host.page
      .getByRole("button", { name: "Add folder to workspace", exact: true })
      .click({ steps: 15 });
    await expect
      .poll(() => host.snapshot().folders)
      .toContain(host.sessions.External.cwd);
    await expect
      .poll(() => host.snapshot().hostPid, { timeout: 30_000 })
      .not.toBe(previousHostPid);
  });
  await test.step("Reselect the session after the host restart", async () => {
    await host.selectSession("External");
    await host.expectDiff("External");
    await expect
      .poll(
        () =>
          host
            .snapshot()
            .repositories.find(
              (repository) => repository.root === host.sessions.External.cwd,
            )?.selected,
      )
      .toBe(true);
    await testInfo.attach("Reselected after restart", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
  });
});

test("New session offers full-path candidates and safely handles cancel, missing cwd and another folder", async ({
  host,
}, testInfo) => {
  await test.step("Inspect the native start candidates and cancel", async () => {
    await openNew(host);
    await expect(
      host.page
        .locator(".quick-input-list")
        .getByText(host.sessions.A.cwd, { exact: true }),
    ).toBeVisible();
    await expect(
      host.page
        .locator(".quick-input-list")
        .getByText(host.sessions.B.cwd, { exact: true }),
    ).toBeVisible();
    await testInfo.attach("Start candidates", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
    await host.page.keyboard.press("Escape");
    expect(host.snapshot().terminals).toHaveLength(0);
  });
  await test.step("Choose a missing start folder and observe a safe error", async () => {
    await openNew(host);
    await host.page
      .locator(".quick-input-list")
      .getByText(host.sessions.Missing.cwd, { exact: true })
      .describe("Missing start candidate")
      .click({ steps: 15 });
    await expect(
      host.page
        .locator(".notification-list-item-message")
        .filter({ hasText: host.sessions.Missing.cwd })
        .first(),
    ).toBeVisible();
    expect(host.snapshot().terminals).toHaveLength(0);
  });
  await test.step("Open another-folder selection and cancel it", async () => {
    await openNew(host);
    await host.page
      .getByText("Choose another folder…", { exact: true })
      .describe("Browse another start folder")
      .click({ steps: 15 });
    await expect(host.page.locator(".quick-input-widget input")).toBeVisible();
    await host.page.keyboard.press("Escape");
    expect(host.snapshot().terminals).toHaveLength(0);
  });
  await test.step("Choose another folder and start real unauthenticated Pi there", async () => {
    await openNew(host);
    await host.page
      .getByText("Choose another folder…", { exact: true })
      .click({ steps: 15 });
    const input = host.page
      .locator(".quick-input-widget input")
      .describe("Another folder path");
    await input.press("Control+a");
    await input.pressSequentially(join(host.directory, "other") + "/", {
      delay: 120,
    });
    await host.page.keyboard.press("Enter");
    await expect
      .poll(() =>
        host
          .piProcesses()
          .some((process) => process.cwd === join(host.directory, "other")),
      )
      .toBe(true);
    await testInfo.attach("Pi started in another folder", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
  });
  await test.step("Choose the worktree candidate and start another real Pi terminal", async () => {
    await openNew(host);
    await host.page
      .locator(".quick-input-list")
      .getByText(host.sessions.B.cwd, { exact: true })
      .describe("Worktree start candidate")
      .click({ steps: 15 });
    await expect
      .poll(() =>
        host
          .piProcesses()
          .some((process) => process.cwd === host.sessions.B.cwd),
      )
      .toBe(true);
    await testInfo.attach("Pi started in selected worktree", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
  });
});

test("missing cwd and deleted sessions fail safely while Git and original headers remain intact", async ({
  host,
}, testInfo) => {
  await test.step("Select a missing work folder and keep terminals and metadata unchanged", async () => {
    const metadata = readFileSync(
      join(host.directory, "agent/session-metadata.json"),
      "utf8",
    );
    await host.selectSession("Missing");
    await expect(
      host.page
        .locator(".notification-list-item-message")
        .filter({ hasText: host.sessions.Missing.cwd })
        .first(),
    ).toBeVisible();
    expect(host.snapshot().terminals).toHaveLength(0);
    expect(
      readFileSync(join(host.directory, "agent/session-metadata.json"), "utf8"),
    ).toBe(metadata);
  });
  await test.step("Delete only the dummy session after listing it and select the stale row", async () => {
    const frame = await host.sessionFrame();
    unlinkSync(host.sessions.Deleted.session);
    await frame
      .locator(`[data-session="${host.sessions.Deleted.id}"] .session-name`)
      .describe("Stale deleted session")
      .click({ steps: 15 });
    await expect(
      host.page
        .locator(".notification-list-item-message")
        .filter({
          hasText: `Session file no longer exists: ${host.sessions.Deleted.id}`,
        })
        .first(),
    ).toBeVisible();
    expect(host.snapshot().terminals).toHaveLength(0);
    await testInfo.attach("Safe deleted-session error", {
      body: await host.page.screenshot(),
      contentType: "image/png",
    });
  });
  await test.step("Compare dummy original files, Git index and worktree contents", async () => {
    for (const [key, session] of Object.entries(host.sessions)) {
      if (key !== "Deleted")
        expect(readFileSync(session.session, "utf8")).toBe(session.original);
    }
    for (const [cwd, original] of Object.entries(host.gitBefore))
      expect(host.gitState(cwd)).toBe(original);
  });
});

test("real Pi first assistant response creates a detected active session", async () => {
  test.skip(
    true,
    "No model credentials or provider are configured in the isolated fixture. Synthetic JSONL detection is not evidence of a real Pi assistant response.",
  );
});

async function openNew(host: VSCodeFixture): Promise<void> {
  const frame = await host.sessionFrame();
  await frame
    .getByRole("button", { name: "New session", exact: true })
    .describe("Start a new Pi session")
    .click({ steps: 15 });
  await expect(host.page.locator(".quick-input-widget input")).toBeVisible();
}
