/**
 * Sessions visible in the tree for a display mode:
 * "active" keeps only sessions marked active, "all" keeps every session.
 */
export function visibleSessions(sessions, mode, activeIds) {
    return mode === "active" ? sessions.filter((session) => activeIds.has(session.sessionId)) : sessions;
}
