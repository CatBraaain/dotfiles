-- Candidate visibility, conversion keys and the Henkan katakana promotion
-- for the managed Kagiroi setup (dotfiles/rime/SPEC.md). Key handling wraps
-- the n-run kana speller, which owns the reading corrections.
local kana_speller = require("kagiroi/kagiroi_n_kana_speller")
local kAccepted = 1
local kHenkan = 0xff23
local kBackSpace = 0xff08
local kEscape = 0xff1b
local kSpace = 0x20
local kReturn = 0xff0d
local Top = { init = kana_speller.init, fini = kana_speller.fini }

-- Henkan (the SPEC's own rule): keep the composition unconfirmed, show the
-- first candidate as katakana, and keep the candidate list hidden. The input
-- is rewritten to its katakana form because the hidden gate leaves no
-- candidates to drive the preedit; the hiragana reading is kept in env so
-- Backspace/Esc can restore it.
local function start_henkan(context, env)
    kana_speller.resolve_conversion(env)
    if not env.henkan_reading then
        env.hira2katakana = env.hira2katakana or Opencc("kagiroi_h2k.json")
        env.henkan_reading = context.input
        env.henkan_katakana = env.hira2katakana:convert(context.input)
        env.previous_katakana = context:get_option("katakana")
        env.previous_hw_katakana = context:get_option("hw_katakana")
    end
    -- The katakana option keeps the katakana candidate first once the menu is
    -- revealed by a later Space.
    context:set_option("katakana", true)
    context:set_option("hw_katakana", false)
    context.input = env.henkan_katakana
    context:set_option("_kagiroi_hide_candidates", true)
    return kAccepted
end

-- End the Henkan state. With restore_reading, put the hiragana reading back
-- into the input (Backspace/Esc); after commits the reading is not restored.
local function end_henkan(context, env, restore_reading)
    if not env.henkan_reading then
        return
    end
    context:set_option("katakana", env.previous_katakana)
    context:set_option("hw_katakana", env.previous_hw_katakana)
    if restore_reading and context.input == env.henkan_katakana then
        context.input = env.henkan_reading
    end
    env.henkan_reading = nil
    env.henkan_katakana = nil
    env.previous_katakana = nil
    env.previous_hw_katakana = nil
end

local function select_next_candidate(context)
    local segment = context.composition:back()
    local next_index = segment.selected_index + 1
    if not segment:get_candidate_at(next_index) then
        next_index = 0
    end
    if type(context.highlight) == "function" then
        context:highlight(next_index)
    else
        -- Windows rime.dll has no context.highlight; move the selection
        -- through the segment property instead.
        segment.selected_index = next_index
    end
end

function Top.func(key_event, env)
    local context = env.engine.context
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return kana_speller.func(key_event, env)
    end

    local keycode = key_event.keycode
    local composing = context.input ~= "" and not context:get_option("ascii_mode")
    local menu_visible = composing and not context:get_option("_kagiroi_hide_candidates")

    if composing and keycode == kHenkan then
        return start_henkan(context, env)
    end

    -- Backspace and Esc return the unconfirmed string to the hiragana
    -- reading with the list hidden. Backspace only does so while converting
    -- (the menu is visible or Henkan is active); plain typing keeps the stock
    -- delete-previous-character. Esc also keeps the reading while typing,
    -- where the stock editor would clear the composition.
    if composing
        and (keycode == kEscape
            or (keycode == kBackSpace and (menu_visible or env.henkan_reading))) then
        end_henkan(context, env, true)
        context:set_option("_kagiroi_hide_candidates", true)
        return kAccepted
    end

    if not composing then
        if keycode >= 0x21 and keycode <= 0x7e
            and env.alphabet:find(string.char(keycode), 1, true) then
            end_henkan(context, env, false)
            context:set_option("_kagiroi_hide_candidates", true)
        end
        return kana_speller.func(key_event, env)
    end

    if keycode == kSpace then
        if not menu_visible then
            local result = kana_speller.func(key_event, env)
            if context.input ~= "" then
                -- While _kagiroi_hide_candidates is on, the gate filter
                -- keeps the menu empty on every engine, so reveal by flipping
                -- the option: the update makes the engine re-compose the
                -- unconfirmed input and rebuild the menu. The first candidate
                -- is already selected by default.
                context:set_option("_kagiroi_hide_candidates", false)
                if context:has_menu() then
                    return kAccepted
                end
                context:set_option("_kagiroi_hide_candidates", true)
            end
            return result
        end
        if context:has_menu() then
            select_next_candidate(context)
            return kAccepted
        end
    elseif keycode == kReturn and (menu_visible and context:has_menu() or env.henkan_reading) then
        context:commit()
        end_henkan(context, env, false)
        return kAccepted
    elseif (menu_visible and context:has_menu() or env.henkan_reading)
        and keycode >= 0x21 and keycode <= 0x7e then
        -- A regular typing key commits the selection before starting the
        -- next full-width input, even while Henkan keeps the menu hidden.
        context:commit()
        end_henkan(context, env, false)
        context:set_option("_kagiroi_hide_candidates", true)
        if keycode >= 0x30 and keycode <= 0x39 then
            -- Kagiroi's alphabet excludes digits, so stock processors would
            -- pass them through instead of starting the next reading.
            context:push_input(string.char(keycode))
            return kAccepted
        end
        return kana_speller.func(key_event, env)
    end

    return kana_speller.func(key_event, env)
end

return Top
