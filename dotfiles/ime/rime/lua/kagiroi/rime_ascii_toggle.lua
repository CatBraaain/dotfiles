local kAccepted = 1
local kNoop = 2
local kZenkakuHankaku = 0xff2a

local function toggle_ascii_mode(key_event, env)
    if key_event.keycode ~= kZenkakuHankaku or key_event:release()
        or key_event:shift() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return kNoop
    end

    local context = env.engine.context
    context:set_option("ascii_mode", not context:get_option("ascii_mode"))
    return kAccepted
end

return { func = toggle_ascii_mode }
