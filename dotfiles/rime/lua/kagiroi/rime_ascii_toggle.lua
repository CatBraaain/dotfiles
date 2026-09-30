local kAccepted = 1
local kNoop = 2
local kZenkakuHankaku = 0xff2a
local kMuhenkan = 0xff22
local controls = require("kagiroi/rime_controls")

-- Zenkaku_Hankaku toggles the unconfirmed ascii input mode; Muhenkan is a
-- one-way switch into it (dotfiles/rime/SPEC.md). The composition is never
-- stashed or committed: half-width characters are appended to it while the
-- mode is on, and the Japanese mode resumes the reading as it is.
local function toggle_ascii_mode(key_event, env)
    local keycode = key_event.keycode
    if key_event:release()
        or key_event:shift() or key_event:ctrl() or key_event:alt() or key_event:super()
        or (keycode ~= kZenkakuHankaku and keycode ~= kMuhenkan) then
        return kNoop
    end

    local context = env.engine.context
    local entering = keycode == kMuhenkan
        or not context:get_option("_kagiroi_ascii_input")
    if entering then
        controls.start_ascii_input(context)
    else
        context:set_option("_kagiroi_ascii_input", false)
    end
    return kAccepted
end

return { func = toggle_ascii_mode }
