local bunsetsu = require("kagiroi/bunsetsu")
local Top = {}

function Top.init(env)
    local context = env.engine.context
    context:set_property("_rime_snapshot_clauses", "none")
    env.snapshot_connection = context.property_update_notifier:connect(function(updated, name)
        if name ~= "_rime_snapshot_observe" then return end
        local state = bunsetsu.state(updated)
        local layout = "none"
        if state then
            local selected = type(state.active) == "number" and math.tointeger(state.active)
            if not selected or selected < 1 or selected > #state.clauses then
                updated:set_property("_rime_snapshot_clauses", "invalid")
                return
            end
            local clauses = {}
            for _, clause in ipairs(state.clauses) do
                local text = clause.override or clause.candidates[clause.selected].text
                if type(text) ~= "string" or text == "" or not utf8.len(text) then
                    updated:set_property("_rime_snapshot_clauses", "invalid")
                    return
                end
                clauses[#clauses + 1] = tostring(#text) .. ":" .. text
            end
            layout = tostring(selected) .. ";" .. table.concat(clauses)
        end
        updated:set_property("_rime_snapshot_clauses", layout)
    end)
end

function Top.fini(env)
    env.snapshot_connection:disconnect()
end

function Top.func()
    return 2
end

return Top
