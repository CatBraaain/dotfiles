local kAccepted = 1
local kNoop = 2
local kZenkakuHankaku = 0xff2a
local controls = require("kagiroi/rime_controls")

local function toggle_ascii_mode(key_event, env)
    if key_event.keycode ~= kZenkakuHankaku or key_event:release()
        or key_event:shift() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return kNoop
    end

    local context = env.engine.context
    local entering_ascii = not context:get_option("ascii_mode")
    if entering_ascii then
        -- Stash the composition instead of committing it
        -- (dotfiles/rime/SPEC.md): the stock ascii composer then treats every
        -- key as plain ascii, and the input returns with the Japanese mode.
        controls.kept.input = context.input ~= "" and context.input or nil
        if controls.kept.input then
            context:set_option("_kagiroi_hide_candidates", true)
        end
        context.input = ""
    elseif controls.kept.input then
        context.input = controls.kept.input
        controls.kept.input = nil
    end
    context:set_option("ascii_mode", entering_ascii)
    return kAccepted
end

return { func = toggle_ascii_mode }
