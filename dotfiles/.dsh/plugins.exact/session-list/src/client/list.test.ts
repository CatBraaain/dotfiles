import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import type { Translate } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionPendingInteractionSnapshot } from "@deepseek-ai/dsh-client-ui-session/client";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { RowListSource, SessionGroup } from "./rows";

type ElementNode = {
  type: unknown;
  props: Record<string, unknown> & { children?: ElementNode | ElementNode[] | null };
};

function createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode {
  const elementProps = props ?? {};
  return {
    type,
    props: {
      ...elementProps,
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] as ElementNode : children as ElementNode[],
    },
  };
}

const stateUpdates: unknown[] = [];
const reactMock = {
  createElement,
  cloneElement: createElement,
  Fragment: "fragment",
  memo: (component: unknown) => component,
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useId: () => "test-id",
  useLayoutEffect: () => {},
  useMemo: <Value>(factory: () => Value) => factory(),
  useRef: <Value>(value: Value) => ({ current: value }),
  useState: <Value>(value: Value) => [value, (next: unknown) => { stateUpdates.push(next) }],
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
};
mock.module("react", () => reactMock);
mock.module("react/jsx-runtime", () => ({
  Fragment: reactMock.Fragment,
  jsx: createElement,
  jsxs: createElement,
}));
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));
const icon = () => null;
mock.module("@deepseek-ai/dsh-client-ui-primitives", () => ({
  IconArchiveOutline20: icon,
  IconCheckOutline16: icon,
  IconCloseFill14: icon,
  IconCopyOutline16: icon,
  IconFolderClose16: icon,
  IconFolderOpen16: icon,
  IconPlusOutline16: icon,
  IconProjectAddOutline16: icon,
  IconTriangleRightFill14: icon,
  StateDot: icon,
  relativeTime: () => ({ unit: "now", n: 0 }),
  writeClipboard: async () => true,
}));

const { GroupSection, createSessionList } = await import("./list");

function workspaceGroup(workspaceId: string | undefined): SessionGroup {
  return {
    key: workspaceId ?? "",
    workspaceId,
    label: workspaceId === undefined ? "" : "Workspace",
    sessions: [],
  };
}

const emptyList: RowListSource = { ids: [], byId: {}, current: undefined };
const emptyPending = new Set() as unknown as SessionPendingInteractionSnapshot;
const translate = ((key: string, params?: Record<string, unknown>) =>
  `${key}:${String(params?.name ?? "")}`) as Translate;

function groupAction(group: SessionGroup, onCreate: (workspaceId: WorkspaceId) => void): ElementNode | undefined {
  const section = GroupSection({
    group,
    collapsed: false,
    overflowExpanded: false,
    onToggle: () => {},
    onCreate,
    onToggleOverflow: () => {},
    now: 0,
    list: emptyList,
    pending: emptyPending,
    t: translate,
    open: () => {},
    archive: () => {},
  }) as ElementNode;
  const header = section.props.children as ElementNode;
  const headerChildren = header.props.children as ElementNode[];
  return headerChildren.find((child) => child?.props?.className === "session-list-group-actions");
}

describe("GroupSection workspace New Session action", () => {
  it("starts a session in the group's workspace without toggling the group", () => {
    const started: string[] = [];
    const action = groupAction(workspaceGroup("workspace-1"), (workspaceId) => {
      started.push(workspaceId);
    });
    assert.ok(action !== undefined);
    if (action === undefined) throw new Error("workspace action must render");
    const button = action.props.children as ElementNode;
    let stopped = false;
    (button.props.onClick as (event: { stopPropagation: () => void }) => void)({
      stopPropagation: () => { stopped = true },
    });
    assert.equal(stopped, true);
    assert.deepEqual(started, ["workspace-1"]);
  });

  it("does not render a New Session action for the ungrouped bucket", () => {
    assert.equal(groupAction(workspaceGroup(undefined), () => {}), undefined);
  });

  it("wires the rendered workspace action to the list dependency", () => {
    const started: string[] = [];
    const SessionList = createSessionList({
      openSession: () => {},
      archiveSession: () => {},
      createWorkspace: async () => ({ workspaceId: "unused" as WorkspaceId }),
      startSession: (workspaceId) => { started.push(workspaceId) },
      renderDirectoryFlow: () => null,
    });
    const sessionSnapshot = { ids: [], byId: {}, current: undefined };
    const workspaceSnapshot = {
      items: [{ workspaceId: "workspace-1", title: "Workspace", sessionIds: [] }],
      archivedSessionIds: [],
    };
    const root = SessionList({
      wide: true,
      expandSidebar: () => {},
      useSessions: (() => sessionSnapshot) as never,
      useSessionPendingInteraction: (() => emptyPending) as never,
      useWorkspaces: (() => workspaceSnapshot) as never,
      useDirectoryFlow: (() => false) as never,
      t: translate,
    });
    const rootElement = root as ElementNode;
    const rootChildren = rootElement.props.children as ElementNode[];
    const listElement = rootChildren[1];
    assert.ok(listElement !== undefined);
    if (listElement === undefined) throw new Error("workspace list must render");
    const groupElement = listElement.props.children as ElementNode[];
    const groupProps = groupElement[0]?.props as { onCreate: (workspaceId: WorkspaceId) => void };
    groupProps.onCreate("workspace-1" as WorkspaceId);
    const collapseUpdate = stateUpdates.at(-1) as ((keys: string[]) => string[]);
    assert.deepEqual(collapseUpdate(["workspace-1"]), []);
    assert.deepEqual(started, ["workspace-1"]);
  });
});
