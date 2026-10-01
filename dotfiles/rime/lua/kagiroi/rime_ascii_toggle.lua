-- Zenkaku_Hankaku and Muhenkan switch between the Japanese input, the
-- unconfirmed ascii input mode and IME OFF (dotfiles/rime/SPEC.md). With an
-- unconfirmed string the keys enter the mode without committing or stashing
-- the composition; with nothing unconfirmed they turn IME OFF through the
-- ascii_mode option. An unmodified Zenkaku_Hankaku keydown returns from
-- IME OFF; other OFF-state keys stay with the frontend (dotfiles/rime/SPEC.md).
local kAccepted = 1
local kNoop = 2
local kZenkakuHankaku = 0xff2a
local kMuhenkan = 0xff22
local controls = require("kagiroi/rime_controls")

local function toggle_ascii_mode(key_event, env)
    local keycode = key_event.keycode
    if key_event:release()
        or key_event:shift() or key_event:ctrl() or key_event:alt() or key_event:super()
        or (keycode ~= kZenkakuHankaku and keycode ~= kMuhenkan) then
        return kNoop
    end

    local context = env.engine.context
    if context:get_option("ascii_mode") then
        if keycode == kZenkakuHankaku then
            context:set_option("ascii_mode", false)
            return kAccepted
        end
        return kNoop
    end
    if context:get_option("_kagiroi_ascii_input") then
        -- Zenkaku_Hankaku returns to the Japanese mode with the composition
        -- kept; Muhenkan inside the mode passes through untouched.
        if keycode == kZenkakuHankaku then
            controls.stop_ascii_input(context)
            return kAccepted
        end
        return kNoop
    end
    if context.input == "" then
        -- Nothing unconfirmed: the keys switch IME OFF
        -- (dotfiles/rime/SPEC.md).
        context:set_option("ascii_mode", true)
        return kAccepted
    end
    controls.start_ascii_input(context, "toggle")
    return kAccepted
end

return { func = toggle_ascii_mode }
