local state
package.loaded["kagiroi/bunsetsu"] = {
    state = function() return state end,
}
local callback
local disconnected = false
local properties = {}
local context = {
    set_property = function(_, name, value) properties[name] = value end,
    property_update_notifier = {
        connect = function(_, listener)
            callback = listener
            return { disconnect = function() disconnected = true end }
        end,
    },
}
local observer = dofile(assert(arg[1]))
local env = { engine = { context = context } }
observer.init(env)
assert(properties._rime_snapshot_clauses == "none")
assert(observer.func({}, env) == 2)
assert(observer.func({ keycode = 0x20 }, env) == 2)
state = {
    active = 2,
    clauses = {
        { selected = 2, candidates = { { text = "京は" }, { text = "今日は" } } },
        { selected = 1, override = "🍛", candidates = { { text = "カレー" } } },
    },
}
callback(context, "unrelated_property")
assert(properties._rime_snapshot_clauses == "none")
callback(context, "_rime_snapshot_observe")
assert(properties._rime_snapshot_clauses == "2;9:今日は4:🍛")
assert(state.clauses[1].selected == 2)
assert(state.clauses[2].override == "🍛" and state.clauses[2].selected == 1)
state.active = 1
callback(context, "_rime_snapshot_observe")
assert(properties._rime_snapshot_clauses == "1;9:今日は4:🍛")
for _, invalid in ipairs({ 0, -1, 3, 1.5, "1" }) do
    state.active = invalid
    callback(context, "_rime_snapshot_observe")
    assert(properties._rime_snapshot_clauses == "invalid")
end
state.active = 1
state.clauses[1].candidates[2].text = "[a,b]"
callback(context, "_rime_snapshot_observe")
assert(properties._rime_snapshot_clauses == "1;5:[a,b]4:🍛")
state.clauses = { { selected = 1, candidates = { { text = "感じ" } } } }
callback(context, "_rime_snapshot_observe")
assert(properties._rime_snapshot_clauses == "1;6:感じ")
for _, invalid in ipairs({ "", "\255", "\227\129" }) do
    state.clauses[1].candidates[1].text = invalid
    callback(context, "_rime_snapshot_observe")
    assert(properties._rime_snapshot_clauses == "invalid")
end
state.clauses = {}
callback(context, "_rime_snapshot_observe")
assert(properties._rime_snapshot_clauses == "invalid")
state = nil
callback(context, "_rime_snapshot_observe")
assert(properties._rime_snapshot_clauses == "none")
observer.fini(env)
assert(disconnected)
print("snapshot observer tests passed")
