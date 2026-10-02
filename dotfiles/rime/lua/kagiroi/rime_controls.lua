-- Candidate visibility, the Space conversion flow, unconfirmed appends and
-- conversion confirmations, the Henkan katakana promotion, the Left/Right
-- segment handling and the unconfirmed ascii input mode for the managed
-- Kagiroi setup (dotfiles/rime/SPEC.md). Key handling wraps the n-run kana
-- speller, which owns the reading corrections.
local kana_speller = require("kagiroi/kagiroi_n_kana_speller")
local bunsetsu = require("kagiroi/bunsetsu")
local kAccepted = 1
local kNoop = 2
local kHenkan = 0xff23
local kBackSpace = 0xff08
local kEscape = 0xff1b
local kSpace = 0x20
local kComma = string.byte(",")
local kPeriod = string.byte(".")
local kMinus = string.byte("-")
local kTab = 0xff09
local kISOLeftTab = 0xfe20
local kUp = 0xff52
local kDown = 0xff54
local kLeft = 0xff51
local kRight = 0xff53
local kReturn = 0xff0d
local kKeypadDecimal = 0xffae
local kKeypadSeparator = 0xffac
local kKeypadEnter = 0xff8b
local kKeypadZero = 0xffb0
local Top = {}

-- How the unconfirmed ascii input mode was entered: "toggle" through
-- Zenkaku_Hankaku or Muhenkan, "shift" through a Shift+letter key. An empty
-- string afterwards continues to IME OFF for the toggle keys and back to the
-- Japanese mode for Shift (dotfiles/rime/SPEC.md).
Top.ascii_input_origin = nil

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

local function hiragana_reading(reading)
    local characters = {}
    for _, codepoint in utf8.codes(reading) do
        if codepoint >= 0x30a1 and codepoint <= 0x30f6
            or codepoint == 0x30fd or codepoint == 0x30fe then
            codepoint = codepoint - 0x60
        end
        characters[#characters + 1] = utf8.char(codepoint)
    end
    return table.concat(characters)
end

local function end_conversion(context, env, restore_reading)
    local conversion = bunsetsu.state(context)
    if env then env.conversion = nil end
    if not conversion then return end
    bunsetsu.clear(context)
    if restore_reading then context.input = hiragana_reading(conversion.reading) end
end

local function conversion_display(context, env)
    return env.conversion and bunsetsu.display(context) or context.input
end

local function commit_unconfirmed(context, env)
    if env.conversion then
        local display = bunsetsu.display(context)
        bunsetsu.learn(context)
        end_conversion(context, env, false)
        env.engine:commit_text(display)
        context.input = ""
    else
        context:commit()
    end
    reset_expansion(context)
    context:set_option("_kagiroi_hide_candidates", true)
    kana_speller.ascii_tail = nil
end

local function start_henkan(context, env)
    end_conversion(context, env, true)
    kana_speller.resolve_conversion(env)
    env.hira2katakana = env.hira2katakana or Opencc("kagiroi_h2k.json")
    local reading = context.input
    context:set_option("_kagiroi_hide_candidates", true)
    reset_expansion(context)
    env.conversion = bunsetsu.start(context, reading, env.hira2katakana:convert(reading))
    return kAccepted
end

local function start_first_candidate_conversion(context, env)
    context:set_option("_kagiroi_hide_candidates", true)
    reset_expansion(context)
    env.conversion = bunsetsu.start(context, context.input)
    return kAccepted
end

local function reveal_conversion(context, env)
    if env.conversion.henkan then
        env.conversion.henkan = false
        env.conversion.clauses[1].override = nil
        env.conversion.clauses[1].selected = 1
        bunsetsu.render(context)
        return kAccepted
    end
    context:set_option("_kagiroi_hide_candidates", false)
    bunsetsu.render(context)
    bunsetsu.select(context, 1)
    return kAccepted
end

local function close_menu(context)
    bunsetsu.sync(context)
    reset_expansion(context)
    context:set_option("_kagiroi_hide_candidates", true)
    bunsetsu.render(context)
end

local function set_candidate_page(context, expanded)
    bunsetsu.sync(context)
    context:set_option("_kagiroi_expand_candidates", expanded)
    bunsetsu.render(context)
end

function Top.init(env)
    kana_speller.init(env)
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
            Top.ascii_input_origin = nil
        end)
    end
end

function Top.fini(env)
    if env.commit_connection then
        env.commit_connection:disconnect()
    end
    kana_speller.fini(env)
end

-- Whether the keycode is a plain letter, shared by the ascii mode entry and
-- the conversion confirmation.
local function is_plain_letter(keycode)
    return keycode >= 0x41 and keycode <= 0x5a
        or keycode >= 0x61 and keycode <= 0x7a
end

-- The text a direct-append key adds to the unconfirmed input, or nil when the
-- key is not one. Digits, symbols and the punctuation extend the unconfirmed
-- text instead of committing it; letters are excluded because while typing
-- they spell the reading and during conversion they confirm it
-- (dotfiles/rime/SPEC.md).
local function appended_text(keycode, in_conversion)
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
    if keycode == kKeypadSeparator then
        return "，"
    end
    if keycode == kComma then
        return "、"
    end
    if keycode == kPeriod then
        return "。"
    end
    if is_plain_letter(keycode) then
        -- Letters spell the reading while typing and confirm the conversion
        -- during conversion; they never append directly
        -- (dotfiles/rime/SPEC.md).
        return nil
    end
    if keycode >= 0x21 and keycode <= 0x7e then
        if keycode == kMinus and not in_conversion then
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
-- text fixed while typing continues after it. The origin records how the
-- mode was entered and decides where an emptied string continues.
function Top.start_ascii_input(context, origin)
    end_conversion(context, nil, true)
    reset_expansion(context)
    context:set_option("_kagiroi_hide_candidates", true)
    kana_speller.ascii_tail = #context.input
    context:set_option("_kagiroi_ascii_input", true)
    Top.ascii_input_origin = origin
end

-- Leave the unconfirmed ascii input mode back to the Japanese mode, keeping
-- the composition and the recorded tail (dotfiles/rime/SPEC.md). The origin
-- record is cleared: the exits after this point no longer depend on it.
function Top.stop_ascii_input(context)
    context:set_option("_kagiroi_ascii_input", false)
    Top.ascii_input_origin = nil
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
    if keycode == kKeypadSeparator then
        return ","
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

-- Leave the emptied ascii input mode: the toggle-origin entry continues to
-- IME OFF, the Shift-origin entry returns to the Japanese input
-- (dotfiles/rime/SPEC.md).
local function leave_emptied_ascii_mode(context)
    kana_speller.ascii_tail = nil
    local origin = Top.ascii_input_origin
    Top.stop_ascii_input(context)
    if origin == "toggle" then
        context:set_option("ascii_mode", true)
    end
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
        Top.stop_ascii_input(context)
        return kAccepted
    end

    if keycode == kBackSpace then
        local last_character = utf8.offset(context.input, -1)
        context.input = last_character and context.input:sub(1, last_character - 1) or ""
        if kana_speller.ascii_tail and kana_speller.ascii_tail > #context.input then
            kana_speller.ascii_tail = #context.input
        end
        if context.input == "" then
            leave_emptied_ascii_mode(context)
        end
        return kAccepted
    end

    if keycode == kEscape then
        context.input = ""
        end_conversion(context, env, false)
        reset_expansion(context)
        leave_emptied_ascii_mode(context)
        return kAccepted
    end

    return kNoop
end

function Top.func(key_event, env)
    local context = env.engine.context
    env.conversion = bunsetsu.state(context)
    if context:get_option("ascii_mode") then
        return kNoop
    end
    if context:get_option("_kagiroi_ascii_input") then
        return Top.ascii_func(key_event, env)
    end
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        bunsetsu.sync(context)
        return kana_speller.func(key_event, env)
    end

    local keycode = key_event.keycode
    if keycode == kKeypadEnter then
        keycode = kReturn
    end
    local composing = context.input ~= ""
    -- The tail of the ascii input mode belongs to the current composition;
    -- an empty input (a fresh session included) invalidates it
    -- (dotfiles/rime/SPEC.md).
    if not composing and kana_speller.ascii_tail then
        kana_speller.ascii_tail = nil
    end
    local menu_visible = composing and env.conversion ~= nil
        and not context:get_option("_kagiroi_hide_candidates")
    local in_conversion = composing and env.conversion ~= nil

    -- Shift+letter switches to the unconfirmed ascii input mode from every
    -- Japanese state (dotfiles/rime/SPEC.md). A conversion returns to its
    -- reading first; the pressed half-width uppercase letter is appended to
    -- the kept string.
    if is_plain_letter(keycode) and key_event:shift() then
        Top.start_ascii_input(context, "shift")
        context:push_input(string.char(keycode):upper())
        kana_speller.ascii_tail = #context.input
        return kAccepted
    end

    -- Punctuation during conversion extends the converted text by the
    -- punctuation without committing it and ends the conversion mode
    -- (dotfiles/rime/SPEC.md, "句読点").
    if in_conversion and (keycode == kComma or keycode == kPeriod) then
        local text = conversion_display(context, env)
        local punctuation = keycode == kComma and "、" or "。"
        end_conversion(context, env, false)
        reset_expansion(context)
        context:set_option("_kagiroi_hide_candidates", true)
        context.input = text .. punctuation
        return kAccepted
    end

    -- A letter during conversion confirms the unconfirmed string and the
    -- pressed key starts the next reading (dotfiles/rime/SPEC.md).
    if in_conversion and is_plain_letter(keycode) then
        commit_unconfirmed(context, env)
        return kana_speller.func(key_event, env)
    end

    local append = appended_text(keycode, in_conversion)
    if append then
        if in_conversion then
            local digit = keycode >= 0x30 and keycode <= 0x39
                or keycode >= kKeypadZero and keycode <= kKeypadZero + 9
            if digit then commit_unconfirmed(context, env)
            else
                local text = conversion_display(context, env)
                end_conversion(context, env, false)
                reset_expansion(context)
                context.input = text
            end
        end
        context:set_option("_kagiroi_hide_candidates", true)
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

    -- Esc closes the candidate list while keeping the conversion, restores
    -- the reading from a hidden conversion, and clears the unconfirmed string
    -- while typing (dotfiles/rime/SPEC.md).
    if composing and keycode == kEscape then
        if menu_visible then
            close_menu(context, env)
            return kAccepted
        end
        if env.conversion then
            end_conversion(context, env, true)
            reset_expansion(context)
            context:set_option("_kagiroi_hide_candidates", true)
            return kAccepted
        end
        context.input = ""
        return kAccepted
    end

    -- Backspace removes the last Unicode character of the converted candidate
    -- and ends conversion.
    if in_conversion and keycode == kBackSpace then
        local text = conversion_display(context, env)
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
        if env.conversion then
            local direction = keycode == kLeft and -1 or 1
            if key_event:shift() then bunsetsu.resize(context, direction)
            else bunsetsu.move(context, direction) end
            return kAccepted
        end
        return kNoop
    end

    if menu_visible and (keycode == kUp or keycode == kDown) and context:has_menu() then
        bunsetsu.select(context, keycode == kUp and -1 or 1, true)
        return kAccepted
    end

    if menu_visible and (keycode == 0xff55 or keycode == 0xff56) then
        bunsetsu.page(context, keycode == 0xff55 and -1 or 1)
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
                bunsetsu.select(context, 1)
            end
            return kAccepted
        elseif env.conversion then
            -- The second Space reveals the list from the stored query.
            return reveal_conversion(context, env)
        else
            -- The first Space resolves the reading and converts the whole
            -- unconfirmed string with the list hidden.
            local result = kana_speller.func(key_event, env)
            if context.input ~= "" then
                local converted = start_first_candidate_conversion(context, env)
                if converted then
                    return converted
                end
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
