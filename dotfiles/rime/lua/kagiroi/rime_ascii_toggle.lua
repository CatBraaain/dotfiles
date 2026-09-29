local kAccepted = 1
local kNoop = 2
local kZenkakuHankaku = 0xff2a

local function toggle_ascii_mode(key_event, env)
    if key_event.keycode ~= kZenkakuHankaku or key_event:release()
        or key_event:shift() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return kNoop
    end

    local context = env.engine.context
    -- Leaving the Japanese mode confirms the composition instead of leaving
    -- it unconfirmed (dotfiles/rime/SPEC.md); the rime_controls processor
    -- cleans its conversion state on the commit. A composition that survived
    -- the switch used to collect the romaji typed in ascii mode and pollute
    -- the reading after switching back.
    if context.input ~= "" then
        context:commit()
        context:set_option("_kagiroi_hide_candidates", true)
    end
    context:set_option("ascii_mode", not context:get_option("ascii_mode"))
    return kAccepted
end

return { func = toggle_ascii_mode }
