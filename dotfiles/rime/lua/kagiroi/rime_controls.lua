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
    if keycode == kHenkan and context.input ~= ""
        and not context:get_option("ascii_mode") then
        if context:get_option("_kagiroi_hide_candidates") then
            -- The gate filter keeps the menu empty while typing; reveal the
            -- candidates so the katakana promotion becomes visible.
            context:set_option("_kagiroi_hide_candidates", false)
        end
        if not context:has_menu() then
            context:set_option("_kagiroi_hide_candidates", true)
            return kana_speller.func(key_event, env)
        end
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
        context:set_option("_kagiroi_hide_candidates", true)
    end

    if context.input ~= "" and not context:get_option("ascii_mode") then
        if keycode == kSpace then
            if context:get_option("_kagiroi_hide_candidates") then
                local result = kana_speller.func(key_event, env)
                if context.input ~= "" then
                    -- While _kagiroi_hide_candidates is on, the gate filter
                    -- keeps the menu empty on every engine, so reveal by
                    -- flipping the option: the option update makes the engine
                    -- re-compose the unconfirmed input and rebuild the menu.
                    -- The first candidate is already selected by default.
                    context:set_option("_kagiroi_hide_candidates", false)
                    if context:has_menu() then
                        return kAccepted
                    end
                    context:set_option("_kagiroi_hide_candidates", true)
                end
                return result
            end
            if context:has_menu() then
                local segment = context.composition:back()
                local next_index = segment.selected_index + 1
                if not segment:get_candidate_at(next_index) then
                    next_index = 0
                end
                if type(context.highlight) == "function" then
                    context:highlight(next_index)
                else
                    -- Windows rime.dll has no context.highlight; move the
                    -- selection through the segment property instead. The
                    -- setter is unverified on Windows, so let errors surface
                    -- rather than hiding them behind pcall.
                    segment.selected_index = next_index
                end
                return kAccepted
            end
        elseif keycode == kReturn and not context:get_option("_kagiroi_hide_candidates") and context:has_menu() then
            context:commit()
            return kAccepted
        end
    end

    return kana_speller.func(key_event, env)
end

return Top
