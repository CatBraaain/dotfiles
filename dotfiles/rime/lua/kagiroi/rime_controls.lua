-- Candidate visibility, the Space conversion flow, digits and the Henkan
-- katakana promotion for the managed Kagiroi setup (dotfiles/rime/SPEC.md).
-- Key handling wraps the n-run kana speller, which owns the reading
-- corrections.
local kana_speller = require("kagiroi/kagiroi_n_kana_speller")
local kAccepted = 1
local kHenkan = 0xff23
local kBackSpace = 0xff08
local kEscape = 0xff1b
local kSpace = 0x20
local kTab = 0xff09
local kReturn = 0xff0d
local kKeypadDecimal = 0xffae
local kKeypadEnter = 0xff8b
local kKeypadZero = 0xffb0
local Top = {}

local function reset_expansion(context)
    context:set_option("_kagiroi_expand_candidates", false)
end

-- env.conversion is the unconfirmed inline conversion state, started by the
-- first Space (the first dictionary candidate) and by Henkan (katakana):
--   reading            what Esc restores the input to
--   display            the text the input was rewritten to
--   query              the input the menu is rebuilt from when Space reveals it
--   advance_on_reveal  move the highlight to the second candidate on reveal;
--                      the first Space already showed the first candidate
--                      inline, while Henkan keeps the first selected
--   restore_katakana   the kana options Henkan flips (nil otherwise)

-- End the inline conversion state. With restore_reading, put the hiragana
-- reading back into the input (Esc); after commits the committed input is kept.
local function end_conversion(context, env, restore_reading)
    local conversion = env.conversion
    if not conversion then
        return
    end
    if conversion.restore_katakana then
        context:set_option("katakana", conversion.restore_katakana.katakana)
        context:set_option("hw_katakana", conversion.restore_katakana.hw_katakana)
    end
    if restore_reading and context.input == conversion.display then
        context.input = conversion.reading
    end
    env.conversion = nil
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

-- Commit whatever is unconfirmed: the selected candidate while the menu is
-- open, the display text during an inline conversion, and the raw reading
-- while typing. The n-run correction belongs to conversion only, so the
-- reading is committed as-is (dotfiles/rime/SPEC.md, "n の過不足補完").
local function commit_unconfirmed(context, env)
    context:commit()
    end_conversion(context, env, false)
    reset_expansion(context)
end

-- Henkan (the SPEC's own rule): keep the composition unconfirmed, show the
-- first candidate as katakana, and keep the candidate list hidden. The input
-- is rewritten to its katakana form because the hidden gate leaves no
-- candidates to drive the preedit; the hiragana reading is kept in the
-- conversion state so Esc can restore it.
local function start_henkan(context, env)
    -- From another conversion, return to the reading first so the katakana
    -- is built from the reading, not from the displayed candidate.
    end_conversion(context, env, true)
    kana_speller.resolve_conversion(env)
    env.hira2katakana = env.hira2katakana or Opencc("kagiroi_h2k.json")
    local katakana = env.hira2katakana:convert(context.input)
    env.conversion = {
        reading = context.input,
        display = katakana,
        query = katakana,
        advance_on_reveal = false,
        restore_katakana = {
            katakana = context:get_option("katakana"),
            hw_katakana = context:get_option("hw_katakana"),
        },
    }
    -- The katakana option keeps the katakana candidate first once the menu is
    -- revealed by a later Space.
    context:set_option("katakana", true)
    context:set_option("hw_katakana", false)
    context.input = katakana
    context:set_option("_kagiroi_hide_candidates", true)
    return kAccepted
end

-- The first Space: keep the list hidden and convert the input to the first
-- candidate. The menu is materialized for a moment to read the candidate;
-- the gate then hides it again and the input is rewritten so the preedit
-- shows the conversion (the hidden gate leaves no candidates to drive the
-- preedit). Returns nil for inputs without a kagiroi menu, leaving the Space
-- to the stock processors.
local function start_first_candidate_conversion(context, env)
    context:set_option("_kagiroi_hide_candidates", false)
    local segment = context.composition:back()
    local first = segment and segment:has_tag("kagiroi")
        and context:has_menu() and segment:get_candidate_at(0)
    if not first then
        context:set_option("_kagiroi_hide_candidates", true)
        return nil
    end
    env.conversion = {
        reading = context.input,
        display = first.text,
        query = context.input,
        advance_on_reveal = true,
    }
    context.input = first.text
    context:set_option("_kagiroi_hide_candidates", true)
    return kAccepted
end

-- Space on an inline conversion: rebuild the menu from the stored query and
-- reveal it, advancing the highlight when the first candidate was already
-- shown inline. Returns nil when no menu builds, leaving the Space to the
-- stock processors.
local function reveal_conversion(context, env)
    reset_expansion(context)
    local conversion = env.conversion
    if context.input ~= conversion.query then
        context.input = conversion.query
    end
    context:set_option("_kagiroi_hide_candidates", false)
    if not context:has_menu() then
        context:set_option("_kagiroi_hide_candidates", true)
        return nil
    end
    if conversion.advance_on_reveal then
        select_next_candidate(context)
        conversion.advance_on_reveal = false
    end
    return kAccepted
end

function Top.init(env)
    kana_speller.init(env)
    local context = env.engine.context
    -- The ascii mode toggle commits the composition directly, so the
    -- conversion state is cleaned up on every commit, not only on the keys
    -- handled here. Older librime-lua builds (Windows Weasel) may not expose
    -- the notifier; the next typing key then cleans the state instead.
    if context.commit_notifier then
        env.commit_connection = context.commit_notifier:connect(function()
            end_conversion(context, env, false)
            reset_expansion(context)
        end)
    end
end

function Top.fini(env)
    if env.commit_connection then
        env.commit_connection:disconnect()
    end
    kana_speller.fini(env)
end

function Top.func(key_event, env)
    local context = env.engine.context
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return kana_speller.func(key_event, env)
    end

    local keycode = key_event.keycode
    -- The keypad digits and Enter act as their main-keyboard keys
    -- (dotfiles/rime/SPEC.md). KP_Decimal is handled apart below because its
    -- main-keyboard twin is the punctuation key instead.
    if keycode >= kKeypadZero and keycode <= kKeypadZero + 9 then
        keycode = 0x30 + keycode - kKeypadZero
    elseif keycode == kKeypadEnter then
        keycode = kReturn
    end

    local composing = context.input ~= "" and not context:get_option("ascii_mode")
    local menu_visible = composing and not context:get_option("_kagiroi_hide_candidates")

    if composing and keycode == kHenkan then
        return start_henkan(context, env)
    end

    -- Esc restores the reading during conversion. Backspace removes the last
    -- Unicode character of the selected candidate and ends conversion.
    if composing and (menu_visible or env.conversion) and keycode == kEscape then
        end_conversion(context, env, true)
        reset_expansion(context)
        context:set_option("_kagiroi_hide_candidates", true)
        return kAccepted
    end

    if composing and (menu_visible or env.conversion) and keycode == kBackSpace then
        local segment = context.composition:back()
        local candidate = menu_visible and context:has_menu()
            and segment and segment:get_candidate_at(segment.selected_index)
        local text = candidate and candidate.text or env.conversion and env.conversion.display or context.input
        local last_character = utf8.offset(text, -1)
        end_conversion(context, env, false)
        context:set_option("_kagiroi_hide_candidates", true)
        context.input = last_character and text:sub(1, last_character - 1) or ""
        return kAccepted
    end

    if composing and keycode == kEscape then
        context.input = ""
        return kAccepted
    end

    if not composing then
        if keycode >= 0x21 and keycode <= 0x7e
            and env.alphabet:find(string.char(keycode), 1, true) then
            end_conversion(context, env, false)
            reset_expansion(context)
            context:set_option("_kagiroi_hide_candidates", true)
        end
        return kana_speller.func(key_event, env)
    end

    -- Digits and the keypad decimal commit whatever is unconfirmed and
    -- become the next reading; they never pick candidates by number.
    if keycode >= 0x30 and keycode <= 0x39 or keycode == kKeypadDecimal then
        commit_unconfirmed(context, env)
        context:set_option("_kagiroi_hide_candidates", true)
        context:push_input(keycode == kKeypadDecimal and "." or string.char(keycode))
        return kAccepted
    end

    if keycode == kTab and menu_visible and context:has_menu()
        and not key_event:shift() and not context:get_option("_kagiroi_expand_candidates") then
        local selected_index = context.composition:back().selected_index
        context:set_option("_kagiroi_expand_candidates", true)
        context:refresh_non_confirmed_composition()
        if context:has_menu() then
            local segment = context.composition:back()
            if segment.selected_index ~= selected_index then
                if type(context.highlight) == "function" then
                    context:highlight(selected_index)
                else
                    segment.selected_index = selected_index
                end
            end
        end
        return kAccepted
    end

    if keycode == kSpace then
        if menu_visible then
            if context:has_menu() then
                select_next_candidate(context)
                return kAccepted
            end
        elseif env.conversion then
            -- The second Space reveals the list from the stored query.
            local revealed = reveal_conversion(context, env)
            if revealed then
                return revealed
            end
        else
            -- The first Space converts to the first candidate with the list
            -- hidden; inputs without candidates keep the stock handling.
            local result = kana_speller.func(key_event, env)
            if context.input ~= "" then
                local converted = start_first_candidate_conversion(context, env)
                if converted then
                    return converted
                end
                context:set_option("_kagiroi_hide_candidates", false)
                if context:has_menu() then
                    return kAccepted
                end
                context:set_option("_kagiroi_hide_candidates", true)
            end
            return result
        end
    elseif keycode == kReturn then
        commit_unconfirmed(context, env)
        return kAccepted
    elseif (menu_visible and context:has_menu() or env.conversion)
        and keycode >= 0x21 and keycode <= 0x7e then
        -- A regular typing key commits the selection before starting the
        -- next full-width input, even while a conversion keeps the menu
        -- hidden.
        commit_unconfirmed(context, env)
        local character = string.char(keycode)
        if character == "," or character == "." then
            -- Open the gate so the downstream punctuator can build its own
            -- candidate and commit the full-width punctuation; the next
            -- typing key re-hides the menu.
            context:set_option("_kagiroi_hide_candidates", false)
            return kana_speller.func(key_event, env)
        end
        context:set_option("_kagiroi_hide_candidates", true)
        return kana_speller.func(key_event, env)
    end

    return kana_speller.func(key_event, env)
end

return Top
