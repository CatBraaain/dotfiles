-- Candidate visibility, the Space conversion flow, unconfirmed appends and
-- conversion confirmations, the Henkan katakana promotion, and the
-- unconfirmed ascii input mode for the managed Kagiroi setup
-- (dotfiles/rime/SPEC.md). Key handling wraps the n-run kana speller, which
-- owns the reading corrections.
local kana_speller = require("kagiroi/kagiroi_n_kana_speller")
local kAccepted = 1
local kNoop = 2
local kHenkan = 0xff23
local kBackSpace = 0xff08
local kEscape = 0xff1b
local kSpace = 0x20
local kTab = 0xff09
local kISOLeftTab = 0xfe20
local kUp = 0xff52
local kDown = 0xff54
local kLeft = 0xff51
local kRight = 0xff53
local kReturn = 0xff0d
local kKeypadDecimal = 0xffae
local kKeypadEnter = 0xff8b
local kKeypadZero = 0xffb0
local Top = {}

-- First-choice symbols for the Japanese mode (dotfiles/rime/SPEC.md, "記号").
-- ASCII symbols without an entry map to their full-width form.
local symbol_text = {
    [string.byte("-")] = "ー",
    [string.byte("/")] = "・",
    [string.byte("\\")] = "￥",
    [string.byte("~")] = "〜",
    [string.byte("|")] = "·",
    [string.byte("[")] = "「",
    [string.byte("]")] = "」",
    [string.byte("{")] = "『",
    [string.byte("}")] = "』",
    [string.byte("'")] = "‘’",
    [string.byte('"')] = "“”",
}

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

local function select_candidate(context, direction)
    local segment = context.composition:back()
    local max_index = context:get_option("_kagiroi_expand_candidates") and math.huge or 9
    local next_index = segment.selected_index + direction
    if direction > 0 and (next_index > max_index or not segment:get_candidate_at(next_index)) then
        next_index = 0
    elseif next_index < 0 then
        next_index = 0
        while next_index < max_index and segment:get_candidate_at(next_index + 1) do
            next_index = next_index + 1
        end
    end
    if type(context.highlight) == "function" then
        context:highlight(next_index)
    else
        -- Windows rime.dll has no context.highlight; move the selection
        -- through the segment property instead.
        segment.selected_index = next_index
    end
end

-- Pin the unconfirmed composition to the text of the selected candidate (menu
-- open) or the inline display, so appends extend the candidate text itself
-- instead of committing it (dotfiles/rime/SPEC.md).
local function pin_selection(context, env)
    local segment = context.composition:back()
    local menu_open = not context:get_option("_kagiroi_hide_candidates")
        and context:has_menu()
    if menu_open and segment then
        local candidate = segment:get_candidate_at(segment.selected_index)
        if candidate then
            end_conversion(context, env, false)
            context.input = candidate.text
        end
    elseif env.conversion then
        end_conversion(context, env, false)
    end
    context:set_option("_kagiroi_hide_candidates", true)
end

-- Commit whatever is unconfirmed: the selected candidate while the menu is
-- open, the display text during an inline conversion, and the raw reading
-- while typing. The n-run correction belongs to conversion only, so the
-- reading is committed as-is (dotfiles/rime/SPEC.md, "n の過不足補完").
local function commit_unconfirmed(context, env)
    -- The MS-IME style selection moves the highlight directly and never
    -- confirms the segment, while librime records the selected candidate
    -- into the user dictionary only when the committing segment is
    -- confirmed. Builds without a Segment.status setter ignore the
    -- assignment silently (learning stays off, commit keeps working).
    local segment = context.composition:back()
    if segment then
        segment.status = "kConfirmed"
    end
    context:commit()
    end_conversion(context, env, false)
    reset_expansion(context)
    -- A committed composition restarts with the list hidden
    -- (dotfiles/rime/SPEC.md).
    context:set_option("_kagiroi_hide_candidates", true)
    kana_speller.ascii_tail = nil
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
        select_candidate(context, 1)
        conversion.advance_on_reveal = false
    end
    return kAccepted
end

-- Switch the candidate page size between ten and thirty, keeping the selected
-- candidate in place across the composition rebuild.
local function set_candidate_page(context, expanded)
    local segment = context.composition:back()
    local selected_index = segment and segment.selected_index
    context:set_option("_kagiroi_expand_candidates", expanded)
    context:refresh_non_confirmed_composition()
    if context:has_menu() then
        segment = context.composition:back()
        if segment and segment.selected_index ~= selected_index then
            if type(context.highlight) == "function" then
                context:highlight(selected_index)
            else
                segment.selected_index = selected_index
            end
        end
    end
end

function Top.init(env)
    kana_speller.init(env)
    -- The ascii toggle enters the mode through this module and reaches the
    -- conversion state via the recorded env.
    Top.env = env
    local context = env.engine.context
    -- Commits end the conversion state wherever they come from (the ascii
    -- toggle used to commit directly; menu selection commits through the
    -- selector). Older librime-lua builds (Windows Weasel) may not expose the
    -- notifier; the next typing key then cleans the state instead.
    if context.commit_notifier then
        env.commit_connection = context.commit_notifier:connect(function()
            end_conversion(context, env, false)
            reset_expansion(context)
            kana_speller.ascii_tail = nil
        end)
    end
end

function Top.fini(env)
    if env.commit_connection then
        env.commit_connection:disconnect()
    end
    kana_speller.fini(env)
end

-- Whether the keycode is a plain letter, shared by appended_text and the
-- conversion confirmation.
local function is_plain_letter(keycode)
    return keycode >= 0x41 and keycode <= 0x5a
        or keycode >= 0x61 and keycode <= 0x7a
end

-- The text a direct-append key adds to the unconfirmed input, or nil when the
-- key is not one. Digits, symbols and the punctuation extend the unconfirmed
-- text instead of committing it; plain letters append only during conversion
-- because while typing they spell the reading (dotfiles/rime/SPEC.md).
local function appended_text(keycode, key_event, in_conversion)
    local main_digit = keycode >= 0x30 and keycode <= 0x39
    local keypad_digit = keycode >= kKeypadZero and keycode <= kKeypadZero + 9
    if main_digit then
        return utf8.char(0xff10 + keycode - 0x30)
    end
    if keypad_digit then
        return string.char(0x30 + keycode - kKeypadZero)
    end
    if keycode == kKeypadDecimal then
        return "．"
    end
    if keycode == string.byte(",") then
        return "、"
    end
    if keycode == string.byte(".") then
        return "。"
    end
    if is_plain_letter(keycode) then
        if key_event:shift() then
            return string.char(keycode):upper()
        end
        return in_conversion and string.char(keycode) or nil
    end
    if keycode >= 0x21 and keycode <= 0x7e then
        if keycode == string.byte("-") and not in_conversion then
            -- While typing, the hyphen spells a long vowel in the reading.
            return nil
        end
        return symbol_text[keycode] or utf8.char(0xff00 + keycode - 0x20)
    end
    return nil
end

-- Enter the unconfirmed ascii input mode (dotfiles/rime/SPEC.md): the
-- conversion state returns to the reading, the candidate list hides, and
-- the tail position is remembered so the kana speller keeps the half-width
-- text fixed while typing continues after it.
function Top.start_ascii_input(context)
    end_conversion(context, Top.env, true)
    reset_expansion(context)
    context:set_option("_kagiroi_hide_candidates", true)
    kana_speller.ascii_tail = #context.input
    context:set_option("_kagiroi_ascii_input", true)
end

-- The half-width text an ascii input mode key appends to the unconfirmed
-- input, or nil when the key is not one: letters, digits, symbols and the
-- space stay half-width (dotfiles/rime/SPEC.md).
local function ascii_appended_text(keycode, key_event)
    if keycode >= 0x30 and keycode <= 0x39 then
        return string.char(keycode)
    end
    if keycode >= kKeypadZero and keycode <= kKeypadZero + 9 then
        return string.char(0x30 + keycode - kKeypadZero)
    end
    if keycode == kKeypadDecimal then
        return "."
    end
    if is_plain_letter(keycode) then
        if key_event:shift() then
            return string.char(keycode):upper()
        end
        return string.char(keycode)
    end
    if keycode == kSpace or (keycode >= 0x21 and keycode <= 0x7e) then
        return string.char(keycode)
    end
    return nil
end

-- Key handling while the unconfirmed ascii input mode is on
-- (dotfiles/rime/SPEC.md): half-width characters extend the unconfirmed
-- input, editing keys keep working, and the mode ends when the composition
-- commits, clears or empties.
function Top.ascii_func(key_event, env)
    local context = env.engine.context
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return kNoop
    end
    local keycode = key_event.keycode
    if keycode == kKeypadEnter then
        keycode = kReturn
    end

    local text = ascii_appended_text(keycode, key_event)
    if text then
        context:push_input(text)
        -- Every appended character belongs to the fixed tail.
        kana_speller.ascii_tail = #context.input
        context:set_option("_kagiroi_hide_candidates", true)
        return kAccepted
    end

    if keycode == kReturn then
        commit_unconfirmed(context, env)
        context:set_option("_kagiroi_ascii_input", false)
        return kAccepted
    end

    if keycode == kBackSpace then
        local last_character = utf8.offset(context.input, -1)
        context.input = last_character and context.input:sub(1, last_character - 1) or ""
        if kana_speller.ascii_tail and kana_speller.ascii_tail > #context.input then
            kana_speller.ascii_tail = #context.input
        end
        if context.input == "" then
            kana_speller.ascii_tail = nil
            context:set_option("_kagiroi_ascii_input", false)
        end
        return kAccepted
    end

    if keycode == kEscape then
        context.input = ""
        end_conversion(context, env, false)
        reset_expansion(context)
        kana_speller.ascii_tail = nil
        context:set_option("_kagiroi_ascii_input", false)
        return kAccepted
    end

    return kNoop
end

function Top.func(key_event, env)
    local context = env.engine.context
    if context:get_option("ascii_mode") then
        return kNoop
    end
    if context:get_option("_kagiroi_ascii_input") then
        return Top.ascii_func(key_event, env)
    end
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return kana_speller.func(key_event, env)
    end

    local keycode = key_event.keycode
    if keycode == kKeypadEnter then
        keycode = kReturn
    end
    local composing = context.input ~= ""
    local menu_visible = composing and not context:get_option("_kagiroi_hide_candidates")
    local in_conversion = composing and (menu_visible or env.conversion)

    local append = appended_text(keycode, key_event, in_conversion)
    if append then
        if in_conversion then
            -- A character key during conversion confirms the selected
            -- candidate first (dotfiles/rime/SPEC.md). A plain letter starts
            -- the next reading; the rest append to a fresh input.
            commit_unconfirmed(context, env)
            if is_plain_letter(keycode) and not key_event:shift() then
                context:set_option("_kagiroi_hide_candidates", true)
                return kana_speller.func(key_event, env)
            end
        else
            if composing then
                pin_selection(context, env)
            end
            context:set_option("_kagiroi_hide_candidates", true)
        end
        context:push_input(append)
        return kAccepted
    end

    -- The full-width space commits immediately while nothing is unconfirmed
    -- (dotfiles/rime/SPEC.md).
    if keycode == kSpace and not composing then
        env.engine:commit_text("　")
        return kAccepted
    end

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
        reset_expansion(context)
        context:set_option("_kagiroi_hide_candidates", true)
        context.input = last_character and text:sub(1, last_character - 1) or ""
        return kAccepted
    end

    if composing and keycode == kEscape then
        context.input = ""
        return kAccepted
    end

    if not composing then
        -- Reading keys start fresh: drop any leftover conversion state so
        -- the kana mode options return to their saved values.
        if env.conversion and keycode >= 0x21 and keycode <= 0x7e then
            end_conversion(context, env, false)
        end
        -- Only reading keys (letters and the hyphen) reach the speller from
        -- here; keep the candidate list hidden for the fresh reading.
        if keycode >= 0x21 and keycode <= 0x7e then
            context:set_option("_kagiroi_hide_candidates", true)
        end
        return kana_speller.func(key_event, env)
    end

    if composing and (keycode == kLeft or keycode == kRight) then
        -- The open candidate list moves the selection across the conversion
        -- blocks through the navigator behind the selector
        -- (dotfiles/rime/SPEC.md). Elsewhere the arrows do nothing.
        if menu_visible and context:has_menu() then
            return kNoop
        end
        return kAccepted
    end

    if menu_visible and (keycode == kUp or keycode == kDown) and context:has_menu() then
        select_candidate(context, keycode == kUp and -1 or 1)
        return kAccepted
    end

    -- Tab only switches the page size: the first Tab expands to thirty, a
    -- second one does nothing, Shift+Tab collapses back to ten and does
    -- nothing before the expand (dotfiles/rime/SPEC.md).
    if keycode == kTab or keycode == kISOLeftTab then
        if menu_visible and context:has_menu() then
            local expanded = context:get_option("_kagiroi_expand_candidates")
            if not key_event:shift() and not expanded then
                set_candidate_page(context, true)
            elseif key_event:shift() and expanded then
                set_candidate_page(context, false)
            end
        end
        return kAccepted
    end

    if keycode == kSpace then
        if menu_visible then
            if context:has_menu() then
                select_candidate(context, 1)
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
    end

    return kana_speller.func(key_event, env)
end

return Top
