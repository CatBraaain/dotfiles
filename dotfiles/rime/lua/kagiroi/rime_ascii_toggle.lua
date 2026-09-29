local kAccepted = 1
local kNoop = 2
local kZenkakuHankaku = 0xff2a
local kHiraganaKatakana = 0xff27
local kMuhenkan = 0xff22
local controls = require("kagiroi/rime_controls")

-- Switch ascii_mode to entering_ascii. The composition is stashed instead of
-- being committed (dotfiles/rime/SPEC.md): the stock ascii composer then
-- treats every key as plain ascii, and the input returns with the Japanese
-- mode.
local function switch_ascii_mode(context, entering_ascii)
    if entering_ascii then
        -- An empty input keeps an earlier stash: the one-way ascii key can
        -- repeat while a stash is already held.
        if context.input ~= "" then
            controls.kept.input = context.input
            context:set_option("_kagiroi_hide_candidates", true)
        end
        context.input = ""
    elseif controls.kept.input then
        context.input = controls.kept.input
        controls.kept.input = nil
    end
    context:set_option("ascii_mode", entering_ascii)
end

local function toggle_ascii_mode(key_event, env)
    local keycode = key_event.keycode
    if key_event:release()
        or key_event:shift() or key_event:ctrl() or key_event:alt() or key_event:super()
        or (keycode ~= kZenkakuHankaku and keycode ~= kHiraganaKatakana and keycode ~= kMuhenkan) then
        return kNoop
    end

    local context = env.engine.context
    -- Zenkaku_Hankaku toggles. Hiragana_Katakana and Muhenkan are one-way
    -- switches: they always select Japanese and ascii input respectively
    -- (dotfiles/rime/SPEC.md).
    if keycode == kHiraganaKatakana then
        switch_ascii_mode(context, false)
    elseif keycode == kMuhenkan then
        switch_ascii_mode(context, true)
    else
        switch_ascii_mode(context, not context:get_option("ascii_mode"))
    end
    return kAccepted
end

return { func = toggle_ascii_mode }
