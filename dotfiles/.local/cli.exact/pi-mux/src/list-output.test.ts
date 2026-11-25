import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mergeSessionLists, renderTable } from "./list-output";
import type { HistoryEntry } from "./saved-sessions";
import type { ListedWorkspace } from "./session-list";

const cwd = "/workspace";

describe("mergeSessionLists", () => {
  it("combines live state with the first matching saved entry", () => {
    const active: ListedWorkspace[] = [
      {
        cwd,
        sessions: [
          {
            id: "shared",
            file: `${cwd}/live.jsonl`,
            title: "Live title",
            state: "waiting-user",
            publishPending: null,
          },
        ],
        empty: [],
      },
    ];
    const saved: HistoryEntry = {
      id: "shared",
      cwd,
      file: `${cwd}/saved.jsonl`,
      title: "Saved title",
      btime: 100,
      mtime: 200,
      size: 300,
    };
    const duplicate = { ...saved, file: `${cwd}/archive/saved.jsonl` };

    assert.deepEqual(mergeSessionLists(active, [saved, duplicate]), [
      {
        cwd,
        sessions: [
          {
            id: "shared",
            file: saved.file,
            title: "Live title",
            state: "waiting-user",
            publishPending: null,
            active: true,
            saved: true,
            btime: 100,
            mtime: 200,
            size: 300,
          },
        ],
      },
    ]);
  });
});

describe("renderTable", () => {
  it("aligns columns by display width, not string length", () => {
    assert.equal(
      renderTable(
        ["ID", "TITLE"],
        [
          ["界", "One"],
          ["a", "Two"],
        ],
      ),
      "ID  TITLE\n界  One\na   Two",
    );
  });
});
