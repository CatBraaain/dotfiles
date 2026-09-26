local kana_speller = require("kagiroi/kagiroi_n_kana_speller")
local kAccepted = 1
local kHenkan = 0xff23
local kSpace = 0x20
local kReturn = 0xff0d
local Top = { init = kana_speller.init, fini = kana_speller.fini }

function Top.func(key_event, env)
    local context = env.engine.context
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return kana_speller.func(key_event, env)
    end

    local keycode = key_event.keycode
    if keycode == kHenkan and context.input ~= "" and context:has_menu()
        and not context:get_option("ascii_mode") then
        if env.previous_katakana == nil then
            env.previous_katakana = context:get_option("katakana")
            env.previous_hw_katakana = context:get_option("hw_katakana")
        end
        context:set_option("hw_katakana", false)
        context:set_option("katakana", true)
        context:set_option("_rime_henkan", true)
        context:highlight(0)
        return kAccepted
    end

    if context.input == "" and keycode >= 0x21 and keycode <= 0x7e
        and env.alphabet:find(string.char(keycode), 1, true) then
        if env.previous_katakana ~= nil then
            context:set_option("_rime_henkan", false)
            context:set_option("katakana", env.previous_katakana)
            context:set_option("hw_katakana", env.previous_hw_katakana)
            env.previous_katakana = nil
            env.previous_hw_katakana = nil
        end
        context:set_option("_hide_candidate", true)
    end

    if context.input ~= "" and not context:get_option("ascii_mode") then
        if keycode == kSpace then
            if context:get_option("_hide_candidate") then
                local result = kana_speller.func(key_event, env)
                if context:has_menu() then
                    context:set_option("_hide_candidate", false)
                    context:highlight(0)
                    return kAccepted
                end
                return result
            end
            if context:has_menu() then
                local segment = context.composition:back()
                local next_index = segment.selected_index + 1
                if not segment:get_candidate_at(next_index) then
                    next_index = 0
                end
                context:highlight(next_index)
                return kAccepted
            end
        elseif keycode == kReturn and not context:get_option("_hide_candidate") and context:has_menu() then
            context:commit()
            return kAccepted
        end
    end

    return kana_speller.func(key_event, env)
end

return Top
