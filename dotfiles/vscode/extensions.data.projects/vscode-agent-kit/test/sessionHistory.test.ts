import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHistory } from "../src/sessionHistory";
import type { PiMuxHistoryEntry, PiMuxWorkspace } from "../src/piMux";
import { fakeRuntimes } from "./runtimeFixtures";

const stores: SessionHistory[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function saved(cwd: string, title = cwd): PiMuxHistoryEntry {
  return {
    id: cwd,
    cwd,
    file: `/missing-history${cwd}/session.jsonl`,
    title,
    btime: 1,
    mtime: 2,
    size: 10,
  };
}

function workspace(cwd: string, live = false): PiMuxWorkspace {
  return {
    cwd,
    sessions: live ? [{ id: cwd, file: saved(cwd).file, state: null, title: null }] : [],
    empty: [],
  };
}

function fixture() {
  const runtimes = fakeRuntimes();
  const observe = vi.fn();
  const store = new SessionHistory(runtimes.mux, vi.fn(), observe);
  stores.push(store);
  return { ...runtimes, store, observe };
}

describe("SessionHistory", () => {
  it("serves other workspaces and keeps useful snapshots while a busy workspace keeps changing", async () => {
    const { store, mocks } = fixture();
    store.sync([workspace("/busy", true), workspace("/other")]);
    let updates = 0;
    mocks.history.mockImplementation(async (cwd) => {
      if (cwd === "/busy" && updates++ < 6) await store.fileChanged(saved(cwd).file);
      return [saved(cwd!)];
    });
    await store.load(() => true);
    expect(mocks.history.mock.calls).toEqual([["/busy"], ["/other"]]);
    expect(store.ready).toBe(true);
    expect(store.entries.map(({ cwd }) => cwd)).toEqual(["/busy", "/other"]);
    mocks.history.mockClear();
    await store.load(() => true);
    expect(mocks.history.mock.calls).toEqual([["/busy"]]);
    expect(store.ready).toBe(true);
  });

  it("rejects an earlier root generation even when a query finishes after the switch", async () => {
    const { store, mocks, observe, history } = fixture();
    const old = saved("/project", "Old root");
    const latest = { ...old, file: "/new-root/session.jsonl", title: "New root" };
    history.set(latest.id, latest);
    store.sync([workspace(old.cwd)]);
    let release!: (entries: PiMuxHistoryEntry[]) => void;
    mocks.history.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const load = store.load(() => true);
    store.resetEntries();
    release([old]);
    await load;
    expect(store.entries).toEqual([]);
    expect(store.ready).toBe(false);
    expect(
      observe.mock.calls.some(([files]) =>
        files.some(({ file }: { file: string }) => file === old.file),
      ),
    ).toBe(false);
    await store.load(() => true);
    expect(store.entries).toEqual([latest]);
    expect(store.ready).toBe(true);
  });

  it("rejects a removed workspace query after the same cwd is registered again", async () => {
    const { store, mocks, history } = fixture();
    const old = saved("/project", "Old registration");
    const latest = { ...old, title: "New registration" };
    history.set(latest.id, latest);
    store.sync([workspace(old.cwd)]);
    let release!: (entries: PiMuxHistoryEntry[]) => void;
    mocks.history.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const load = store.load(() => true);
    store.sync([]);
    store.sync([workspace(old.cwd)]);
    release([old]);
    await load;
    expect(store.entries).toEqual([]);
    await store.load(() => true);
    expect(store.entries).toEqual([latest]);
  });

  it("keeps mappings on failure until a successful retry removes deleted files", async () => {
    const { store, mocks, history, observe } = fixture();
    const entry = saved("/project");
    history.set(entry.id, entry);
    store.sync([workspace(entry.cwd)]);
    await store.load(() => true);
    history.clear();
    await store.fileChanged(entry.file);
    mocks.history.mockRejectedValueOnce(new Error("history unavailable"));
    await expect(store.load(() => true)).rejects.toThrow("history unavailable");
    expect(observe.mock.lastCall?.[0]).toEqual([{ file: entry.file, cwd: entry.cwd }]);
    expect(await store.fileChanged(entry.file)).toBe(true);
    store.invalidateAll();
    await store.load(() => true);
    expect(observe.mock.lastCall?.[0]).toEqual([]);
    expect(await store.fileChanged(entry.file)).toBe(false);
  });

  it("retains pending delete notifications until the following successful batch", async () => {
    const { store, mocks, history, observe } = fixture();
    const entry = saved("/project");
    history.set(entry.id, entry);
    store.sync([workspace(entry.cwd)]);
    await store.load(() => true);
    store.invalidateAll();
    let release!: (entries: PiMuxHistoryEntry[]) => void;
    mocks.history.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const load = store.load(() => true);
    history.clear();
    await store.fileChanged(entry.file);
    release([entry]);
    await load;
    expect(store.ready).toBe(true);
    expect(observe.mock.lastCall?.[0]).toEqual([{ file: entry.file, cwd: entry.cwd }]);
    await store.load(() => true);
    expect(observe.mock.lastCall?.[0]).toEqual([]);
    expect(await store.fileChanged(entry.file)).toBe(false);
  });

  it("retires an old deleted path even when a different file changes during acquisition", async () => {
    const { store, mocks, history, observe } = fixture();
    const entry = saved("/project");
    const liveFile = "/planned/session.jsonl";
    history.set(entry.id, entry);
    store.sync([{ ...workspace(entry.cwd), empty: [{ id: "planned", file: liveFile }] }]);
    await store.load(() => true);
    history.clear();
    await store.fileChanged(entry.file);
    let release!: (entries: PiMuxHistoryEntry[]) => void;
    mocks.history.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const load = store.load(() => true);
    await store.fileChanged(liveFile);
    release([]);
    await load;
    expect(observe.mock.lastCall?.[0]).toEqual([{ file: liveFile, cwd: entry.cwd }]);
    expect(await store.fileChanged(entry.file)).toBe(false);
  });

  it("keeps planned live file mappings while history is empty and releases them when no longer live", async () => {
    const { store, observe } = fixture();
    const entry = saved("/project");
    store.sync([{ ...workspace(entry.cwd), empty: [{ id: entry.id, file: entry.file }] }]);
    await store.load(() => true);
    expect(observe.mock.lastCall?.[0]).toEqual([{ file: entry.file, cwd: entry.cwd }]);
    store.sync([workspace(entry.cwd)]);
    expect(observe.mock.lastCall?.[0]).toEqual([]);
  });

  it("removes deleted path mappings after successful empty acquisition", async () => {
    const { store, history, observe } = fixture();
    const entry = saved("/project");
    history.set(entry.id, entry);
    store.sync([workspace(entry.cwd)]);
    await store.load(() => true);
    expect(observe.mock.lastCall?.[0]).toEqual([{ file: entry.file, cwd: entry.cwd }]);
    history.clear();
    expect(await store.fileChanged(entry.file)).toBe(true);
    await store.load(() => true);
    expect(observe.mock.lastCall?.[0]).toEqual([]);
    expect(await store.fileChanged(entry.file)).toBe(false);
  });
});
