import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/vscode";
import type { VSCodeFixture } from "../support/vscode";

test.use({ trace: "on" });

const SCM_EVIDENCE_SCOPE =
  "A/B evidence covers visible repositories with Graph Auto only. Hidden repositories, fixed Graph selection and active repository pin remain unmet and were not executed in this run. Owner decision is pending (G1). This note does not resolve G1 or the real assistant response gap (G3).";

test(
  "同名の本体・worktree フォルダを見分け、未アーカイブ 0 件の作業先の履歴を All モードで開ける",
  { annotation: { type: "spec", description: "E2E-1" } },
  async ({ host }, testInfo) => {
    await test.step("Read the work folder hints and inspect the empty Unarchived group", async () => {
      const frame = await host.sessionFrame();
      for (const key of ["A", "B"]) {
        const group = frame
          .locator("section.group")
          .filter({ has: frame.getByTitle(host.sessions[key].cwd, { exact: true }) })
          .describe(`${key} work folder group`);
        const heading = group.locator(".group-header").describe(`${key} work folder heading`);
        await expect(heading).toBeVisible();
        await expect(heading).toHaveAttribute("title", host.sessions[key].cwd);
        await expect(heading.locator(".group-title")).toHaveText("project");
        await expect(group.getByRole("button", { name: "Unarchived", exact: true })).toBeVisible();
        await expect(group.getByRole("button", { name: "All", exact: true })).toBeVisible();
        await expect(frame.getByText(host.sessions[key].cwd, { exact: true })).toHaveCount(0);
      }
      const emptyGroup = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.B.cwd, { exact: true }) })
        .describe("Empty B Unarchived group");
      await expect(emptyGroup.locator(".session-row")).toHaveCount(0);
      await expect(emptyGroup.locator(".empty")).toHaveCount(0);
      await expect(frame.locator(".group-path")).toHaveCount(0);
      await expect(
        frame.getByText("No unarchived sessions. Select All to browse saved sessions.", {
          exact: true,
        }),
      ).toHaveCount(0);
      await testInfo.attach("Unarchived（切替前）", {
        body: await host.page.screenshot({ path: testInfo.outputPath("unarchived.png") }),
        contentType: "image/png",
      });
    });
    await test.step("Choose All in the inactive worktree group", async () => {
      const frame = await host.sessionFrame();
      await expect(
        frame
          .locator("section.group")
          .first()
          .locator(".group-header")
          .describe("Top session group heading"),
      ).toHaveAttribute("title", host.sessions.B.cwd);
      const group = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.B.cwd, { exact: true }) });
      await group.locator('[data-mode="all"]').describe("Worktree history").click({ steps: 15 });
      await expect(
        frame
          .locator(`[data-session="${host.sessions.B.id}"]`)
          .describe("Saved inactive B session"),
      ).toBeVisible();
      await testInfo.attach("All（履歴）", {
        body: await host.page.screenshot({ path: testInfo.outputPath("all.png") }),
        contentType: "image/png",
      });
    });
  },
);

test(
  "A/B の会話切替と表示タブの開閉後も、生存する実 Pi へ再接続する",
  { annotation: { type: "spec", description: "E2E-2" } },
  async ({ host }, testInfo) => {
    const firstPids = new Map<string, number>();
    const displayPids = new Set<number>();
    const selections = ["A", "B", "A", "B"];
    for (const [index, key] of selections.entries()) {
      const isLastSelection = index === selections.length - 1;
      await test.step(`Select ${key} and open its Pi terminal`, async () => {
        const frame = await host.sessionFrame();
        const expectedGroupName = key === "A" ? "project-a" : "project-b";
        await expect(
          frame
            .getByTitle(host.sessions[key].cwd, { exact: true })
            .locator(".group-title")
            .describe(`${key} work folder name`),
        ).toHaveText(expectedGroupName);
        await host.selectSession(key);
      });
      await test.step(`Check the real ${key} Pi process cwd and PID reuse`, async () => {
        await expect
          .poll(() => host.piProcesses().some((process) => process.cwd === host.sessions[key].cwd))
          .toBe(true);
        const matches = host
          .piProcesses()
          .filter((process) => process.cwd === host.sessions[key].cwd);
        expect(matches).toHaveLength(1);
        const pi = matches[0];
        const priorPid = firstPids.get(key);
        if (priorPid !== undefined) expect(pi.pid).toBe(priorPid);
        else firstPids.set(key, pi.pid);
        await testInfo.attach(`${key} real process evidence`, {
          body: JSON.stringify(host.piProcesses(), null, 2),
          contentType: "application/json",
        });
      });
      await test.step(`Read ${key} original session path and ID in the real Pi TUI`, async () => {
        await host.expectPiVisible(host.sessions[key].cwd);
        const displayPid = host.snapshot().terminals.find((terminal) => terminal.owned)!.pid;
        displayPids.add(displayPid);
        expect(displayPids.size).toBe(1);
        const terminalInput = host.page
          .getByRole("textbox", { name: /Terminal [0-9]+, Pi/ })
          .describe("Shared Pi command input");
        await terminalInput.pressSequentially("/session", { delay: 120 });
        await terminalInput.press("Enter");
        await expect
          .poll(async () => (await host.page.locator("body").innerText()).replace(/\s/g, ""))
          .toContain(host.sessions[key].session);
        if (index === selections.length - 2 || isLastSelection) {
          const displayTarget = host.tmux(["list-clients", "-F", "#{session_name}"]).trim();
          const frame = await host.sessionFrame();
          await expect(
            host.page
              .getByRole("tab", { name: "Agent Sessions", exact: true })
              .describe("Active Sessions sidebar"),
          ).toHaveAttribute("aria-selected", "true");
          const selectedRow = frame
            .locator(".session-row.selected")
            .describe("Selected conversation");
          await expect(selectedRow).toHaveCount(1);
          await expect(
            selectedRow
              .locator(`[data-session="${host.sessions[key].id}"]`)
              .describe(`${key} selected before capturing its Pi TUI`),
          ).toBeVisible();
          await host.page.mouse.move(800, 80);
          await expect
            .poll(() =>
              host
                .snapshot()
                .terminals.filter((terminal) => terminal.owned)
                .map(({ name, pid }) => ({ name, pid })),
            )
            .toEqual([{ name: "Pi", pid: displayPid }]);
          await expect
            .poll(() =>
              host
                .snapshot()
                .tabs.filter((tab) => tab.terminal)
                .map(({ label, active }) => ({ label, active })),
            )
            .toEqual([{ label: "Pi", active: true }]);
          await expect(terminalInput).toBeVisible();
          await expect
            .poll(async () => (await host.page.locator("body").innerText()).replace(/\s/g, ""))
            .toContain(host.sessions[key].session);
          expect(host.tmux(["list-clients", "-F", "#{session_name}"]).trim()).toBe(displayTarget);
          expect(
            host.piProcesses().filter((entry) => entry.target === displayTarget),
          ).toMatchObject([{ pid: firstPids.get(key), cwd: host.sessions[key].cwd }]);
          await testInfo.attach(`${key} の Pi TUI`, {
            body: await host.page.screenshot({ path: testInfo.outputPath(`${key}-pi-tui.png`) }),
            contentType: "image/png",
          });
        }
        expect(
          readFileSync(host.sessions[key].session, "utf8").startsWith(host.sessions[key].original),
        ).toBe(true);
        expect(host.gitState(host.sessions[key].cwd)).toBe(host.gitBefore[host.sessions[key].cwd]);
      });
    }
    await test.step("Close only the shared display and reconnect to the same A and B processes", async () => {
      await host.closePiDisplay();
      expect(
        host
          .piProcesses()
          .map((entry) => entry.pid)
          .sort(),
      ).toEqual([...firstPids.values()].sort());
      await host.selectSession("A");
      await host.expectPiVisible(host.sessions.A.cwd);
      expect(host.piProcesses().find((entry) => entry.cwd === host.sessions.A.cwd)?.pid).toBe(
        firstPids.get("A"),
      );
      await host.selectSession("B");
      await host.expectPiVisible(host.sessions.B.cwd);
      expect(host.piProcesses().find((entry) => entry.cwd === host.sessions.B.cwd)?.pid).toBe(
        firstPids.get("B"),
      );
    });
    await test.step("Restart only an exited selected Pi from its saved session", async () => {
      const runtime = host.piProcesses().find((entry) => entry.cwd === host.sessions.A.cwd)!;
      process.kill(runtime.pid, "SIGTERM");
      await expect
        .poll(() => host.piProcesses().some((entry) => entry.cwd === host.sessions.A.cwd))
        .toBe(false);
      await host.selectSession("A");
      await host.expectPiVisible(host.sessions.A.cwd);
      const restarted = host.piProcesses().filter((entry) => entry.cwd === host.sessions.A.cwd);
      expect(restarted).toHaveLength(1);
      expect(restarted[0].pid).not.toBe(firstPids.get("A"));
      expect(host.piProcesses().find((entry) => entry.cwd === host.sessions.B.cwd)?.pid).toBe(
        firstPids.get("B"),
      );
    });
  },
);

test(
  "会話の選択ごとに、その作業先の変更の diff と SCM へ切り替わる",
  { annotation: { type: "spec", description: "E2E-10" } },
  async ({ host }, testInfo) => {
    testInfo.annotations.push({
      type: "SCM coverage limitation",
      description: SCM_EVIDENCE_SCOPE,
    });
    await testInfo.attach("SCM evidence scope and unmet conditions", {
      body: SCM_EVIDENCE_SCOPE,
      contentType: "text/plain",
    });
    for (const key of ["A", "B"]) {
      await test.step(`Select ${key} and wait for its native diff`, async () => {
        await host.selectSession(key);
        await host.expectPiVisible(host.sessions[key].cwd);
        await host.expectDiff(key);
      });
      await test.step(`Observe ${key} SCM focus without changing settings`, async () => {
        await expect
          .poll(
            () =>
              host
                .snapshot()
                .repositories.find((repository) => repository.root === host.sessions[key].cwd)
                ?.selected,
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
        await testInfo.attach(`${key} の diff`, {
          body: await host.page.screenshot(),
          contentType: "image/png",
        });
      });
    }
  },
);

test(
  "SCM の非表示リポジトリ・固定 Graph・active pin は未達: 未実行、決定待ち",
  { annotation: { type: "spec", description: "E2E-8" } },
  async () => {
    test.skip(true, SCM_EVIDENCE_SCOPE);
  },
);

test(
  "SCM から Sessions へ戻っても、Refresh なしで一覧を復元する",
  { annotation: { type: "spec", description: "E2E-3" } },
  async ({ host }, testInfo) => {
    const selections = ["B", "A", "B", "A"];
    for (const [index, key] of selections.entries()) {
      const isFinalRestore = index === selections.length - 1;
      await test.step(`Return from SCM and select ${key} without Refresh`, async () => {
        await host.selectSession(key);
        await host.expectDiff(key);
        if (isFinalRestore)
          await testInfo.attach("SCM 表示中", {
            body: await host.page.screenshot(),
            contentType: "image/png",
          });
        const frame = await host.sessionFrame();
        await expect(frame.locator("section.group")).toHaveCount(4);
        await expect(
          frame
            .getByTitle(host.sessions.B.cwd, { exact: true })
            .describe("Restored B work folder heading"),
        ).toBeVisible();
        if (isFinalRestore)
          await testInfo.attach("Sessions 復元後", {
            body: await host.page.screenshot(),
            contentType: "image/png",
          });
      });
    }
  },
);

test(
  "会話選択を受け付けた時点のエディタが、対象の変更ファイルを決める",
  { annotation: { type: "spec", description: "E2E-4" } },
  async ({ host }, testInfo) => {
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
      await testInfo.attach("選択時のエディタ", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    await test.step("Select B and wait for that file's active diff", async () => {
      await host.selectSession("B");
      await host.expectPiVisible(host.sessions.B.cwd);
      await host.expectDiff("B", "z-preferred.txt");
      await testInfo.attach("選択後の diff", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
  },
);

test(
  "単一ルートへの明示的なフォルダ追加が、拡張 host 再起動後の再選択でも成立する",
  {
    tag: "@single-root",
    annotation: { type: "spec", description: "E2E-5" },
  },
  async ({ host }, testInfo) => {
    await test.step("Open an unregistered session without adding its folder", async () => {
      await host.selectSession("External");
      await expect(
        host.page
          .getByRole("button", { name: "Add folder to workspace", exact: true })
          .describe("Explicit add-folder action"),
      ).toBeVisible();
      expect(host.snapshot().folders).toEqual([host.sessions.A.cwd]);
      await host.expectPiVisible(host.sessions.External.cwd);
      await testInfo.attach("同意要求", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    const previousHostPid = host.snapshot().hostPid;
    const previousPiPid = host
      .piProcesses()
      .find((entry) => entry.cwd === host.sessions.External.cwd)!.pid;
    await test.step("Explicitly add the folder and observe a new extension host", async () => {
      await host.page
        .getByRole("button", { name: "Add folder to workspace", exact: true })
        .click({ steps: 15 });
      await expect.poll(() => host.snapshot().folders).toContain(host.sessions.External.cwd);
      await expect
        .poll(() => host.snapshot().hostPid, { timeout: 30_000 })
        .not.toBe(previousHostPid);
    });
    await test.step("Reselect the session after the host restart", async () => {
      await host.selectSession("External");
      await host.expectPiVisible(host.sessions.External.cwd);
      const processes = host
        .piProcesses()
        .filter((entry) => entry.cwd === host.sessions.External.cwd);
      expect(processes).toHaveLength(1);
      expect(processes[0].pid).toBe(previousPiPid);
      await host.expectDiff("External");
      await expect
        .poll(
          () =>
            host
              .snapshot()
              .repositories.find((repository) => repository.root === host.sessions.External.cwd)
              ?.selected,
        )
        .toBe(true);
      await testInfo.attach("再起動後の再選択", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
  },
);

test(
  "New Session がフルパス候補を出し、キャンセル・無効な開始先・別フォルダ選択を安全に扱う",
  { annotation: { type: "spec", description: "E2E-6" } },
  async ({ host }, testInfo) => {
    await test.step("Inspect the native start candidates and cancel", async () => {
      await openNew(host);
      await expect(
        host.page.locator(".quick-input-list").getByText(host.sessions.A.cwd, { exact: true }),
      ).toBeVisible();
      await expect(
        host.page.locator(".quick-input-list").getByText(host.sessions.B.cwd, { exact: true }),
      ).toBeVisible();
      await testInfo.attach("候補一覧", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
      await host.page.keyboard.press("Escape");
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
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
      expect(host.piProcesses()).toHaveLength(0);
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
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Choose another folder and start real unauthenticated Pi there", async () => {
      await openNew(host);
      await host.page.getByText("Choose another folder…", { exact: true }).click({ steps: 15 });
      const input = host.page.locator(".quick-input-widget input").describe("Another folder path");
      await input.press("Control+a");
      await input.pressSequentially(join(host.directory, "other") + "/", {
        delay: 120,
      });
      await host.page.keyboard.press("Enter");
      await expect
        .poll(() =>
          host.piProcesses().some((process) => process.cwd === join(host.directory, "other")),
        )
        .toBe(true);
      await host.expectPiVisible(join(host.directory, "other"));
      await testInfo.attach("別フォルダで起動", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    await test.step("Choose the worktree candidate and share the same display for another Pi", async () => {
      await openNew(host);
      await host.page
        .locator(".quick-input-list")
        .getByText(host.sessions.B.cwd, { exact: true })
        .describe("Worktree start candidate")
        .click({ steps: 15 });
      await expect
        .poll(() => host.piProcesses().some((process) => process.cwd === host.sessions.B.cwd))
        .toBe(true);
      await host.expectPiVisible(host.sessions.B.cwd);
      expect(host.piProcesses()).toHaveLength(2);
    });
  },
);

test(
  "存在しない cwd・削除済みセッションファイルの選択を安全に扱い、セッション原本と Git を変更しない",
  { annotation: { type: "spec", description: "E2E-7" } },
  async ({ host }, testInfo) => {
    await test.step("Select a missing work folder and keep terminals and metadata unchanged", async () => {
      const metadata = readFileSync(join(host.directory, "agent/session-metadata.json"), "utf8");
      await host.selectSession("Missing");
      await expect(
        host.page
          .locator(".notification-list-item-message")
          .filter({ hasText: host.sessions.Missing.cwd })
          .first(),
      ).toBeVisible();
      await testInfo.attach("不在 cwd のエラー", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
      expect(readFileSync(join(host.directory, "agent/session-metadata.json"), "utf8")).toBe(
        metadata,
      );
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
      expect(host.piProcesses()).toHaveLength(0);
      await testInfo.attach("削除済みのエラー", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    await test.step("Compare dummy original files, Git index and worktree contents", async () => {
      for (const [key, session] of Object.entries(host.sessions)) {
        if (key !== "Deleted") expect(readFileSync(session.session, "utf8")).toBe(session.original);
      }
      for (const [cwd, original] of Object.entries(host.gitBefore))
        expect(host.gitState(cwd)).toBe(original);
    });
  },
);

test(
  "実 Pi の最初の assistant 応答による新規セッションの検出と active 付与",
  { annotation: { type: "spec", description: "E2E-9" } },
  async () => {
    test.skip(
      true,
      "No model credentials or provider are configured in the isolated fixture. Synthetic JSONL detection is not evidence of a real Pi assistant response.",
    );
  },
);

async function openNew(host: VSCodeFixture): Promise<void> {
  const frame = await host.sessionFrame();
  await frame
    .getByRole("button", { name: "New session", exact: true })
    .describe("Start a new Pi session")
    .click({ steps: 15 });
  await expect(host.page.locator(".quick-input-widget input")).toBeVisible();
}
