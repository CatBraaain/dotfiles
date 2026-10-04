-- Candidate visibility, the Space conversion flow, unconfirmed appends and
-- conversion confirmations, the Henkan katakana promotion, the Left/Right
-- segment handling and the unconfirmed ascii input mode for the managed
-- Kagiroi setup (dotfiles/rime/SPEC.md). Key handling wraps the n-run kana
-- speller, which owns the reading corrections.
local kana_speller = require("kagiroi/kagiroi_n_kana_speller")
local bunsetsu = require("kagiroi/bunsetsu")
local kAccepted = 1
local kNoop = 2
local kRejected = 0
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
local kKeypadEqual = 0xffbd
local kKeypadDivide = 0xffaf
local kKeypadMultiply = 0xffaa
local kKeypadSubtract = 0xffad
local kKeypadAdd = 0xffab
local Top = {}

-- Keypad symbols add their half-width character in both the Japanese and
-- the half-width input mode; the ordinary symbol keys keep their separate
-- Japanese mappings (dotfiles/rime/SPEC.md, "共通の文字対応").
local keypad_symbol_text = {
    [kKeypadDecimal] = ".",
    [kKeypadSeparator] = ",",
    [kKeypadAdd] = "+",
    [kKeypadSubtract] = "-",
    [kKeypadMultiply] = "*",
    [kKeypadDivide] = "/",
    [kKeypadEqual] = "=",
}

-- The editing, mode and emoji shortcuts the SPEC lists must reach the
-- application unassigned in every IME ON state
-- (dotfiles/rime/SPEC.md, "ショートカット"). The processor chain is stopped
-- for them so stock components cannot consume them either: the selector's
-- digit-key fallback ignores modifiers and would otherwise eat
-- Control+Shift+<digit> while composing.
local shortcut_letters = {}
for _, letter in ipairs({ "p", "n", "b", "f", "a", "e", "d", "k", "h", "g", "q", "[" }) do
    shortcut_letters[string.byte(letter)] = true
end
local shortcut_shift_keys = {}
for _, key in ipairs({ "1", "2", "3", "4", "5", "!", "@", "#", "$", "%" }) do
    shortcut_shift_keys[string.byte(key)] = true
end

local function listed_shortcut(key_event)
    if key_event:release() or not key_event:ctrl()
        or key_event:alt() or key_event:super() then
        return false
    end
    local keycode = key_event.keycode
    if key_event:shift() then
        return shortcut_shift_keys[keycode] == true
    end
    return shortcut_letters[keycode] == true
end

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
    context:set_option("_kagiroi_off_pending", false)
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
    context:set_option("_kagiroi_off_pending", false)
    reset_expansion(context)
    env.conversion = bunsetsu.start(context, context.input)
    return kAccepted
end

local function reveal_conversion(context, env)
    context:set_option("_kagiroi_off_pending", false)
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
            context:set_option("_kagiroi_off_pending", false)
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
-- key is not one. Digits, symbols, punctuation and keypad character keys
-- extend the unconfirmed text while typing and commit the whole display
-- during conversion; letters are excluded because while typing they spell
-- the reading and during conversion they confirm it
-- (dotfiles/rime/SPEC.md). Enter belongs to the separate commit contract.
local function appended_text(keycode, in_conversion)
    local main_digit = keycode >= 0x30 and keycode <= 0x39
    local keypad_digit = keycode >= kKeypadZero and keycode <= kKeypadZero + 9
    if main_digit then
        return utf8.char(0xff10 + keycode - 0x30)
    end
    if keypad_digit then
        return string.char(0x30 + keycode - kKeypadZero)
    end
    local keypad_symbol = keypad_symbol_text[keycode]
    if keypad_symbol then
        return keypad_symbol
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

local function keep_display_for_editing(context, env)
    local conversion = bunsetsu.state(context)
    if conversion then
        local display = bunsetsu.display(context)
        bunsetsu.clear(context)
        context.input = display
        if env then env.conversion = nil end
    end
    reset_expansion(context)
    context:set_option("_kagiroi_hide_candidates", true)
end

local function prepare_append(context)
    context.caret_pos = #context.input
    context:set_option("_kagiroi_off_pending", false)
    context:set_option("_kagiroi_hide_candidates", true)
    reset_expansion(context)
end

function Top.start_ascii_input(context, reserve_off)
    -- Sync the selection from the live segment before any option write:
    -- librime rebuilds the menu on an option change and drops the highlight.
    if bunsetsu.state(context) then bunsetsu.sync(context) end
    if reserve_off then context:set_option("_kagiroi_off_pending", true) end
    local context_input = context.input
    -- The recorded tail survives only inside the same composition: entering
    -- the mode from one composition to another starts a fresh tail.
    local current_tail = context:get_option("_kagiroi_ascii_input")
        and kana_speller.ascii_tail or nil
    if current_tail == nil or current_tail > #context_input then
        current_tail = #context_input
    end
    if current_tail < #context_input
        and context_input:sub(current_tail + 1):find("^[^\\128-\\191]", 1) == nil then
        -- The tail boundary fell inside a multibyte character: refuse to
        -- overwrite half of it, and lose the tail instead.
        current_tail = 0
    end
    kana_speller.ascii_tail = current_tail
    context:set_option("_kagiroi_ascii_input", true)
    if bunsetsu.state(context) then bunsetsu.render(context) end
end

function Top.stop_ascii_input(context)
    keep_display_for_editing(context)
    kana_speller.ascii_tail = #context.input
    context:set_option("_kagiroi_ascii_input", false)
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
    local keypad_symbol = keypad_symbol_text[keycode]
    if keypad_symbol then
        return keypad_symbol
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

local function finish_deletion(context)
    if kana_speller.ascii_tail then
        kana_speller.ascii_tail = math.min(kana_speller.ascii_tail, #context.input)
    end
    if context.input ~= "" then return end
    kana_speller.ascii_tail = nil
    local pending = context:get_option("_kagiroi_off_pending")
    context:set_option("_kagiroi_ascii_input", false)
    context:set_option("_kagiroi_off_pending", false)
    context:set_option("ascii_mode", pending)
end

local function delete_last_character(context, env)
    keep_display_for_editing(context, env)
    local last_character = utf8.offset(context.input, -1)
    context.input = last_character and context.input:sub(1, last_character - 1) or ""
    finish_deletion(context)
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
        keep_display_for_editing(context, env)
        prepare_append(context)
        context:push_input(text)
        -- Every appended character belongs to the fixed tail.
        kana_speller.ascii_tail = #context.input
        return kAccepted
    end

    if keycode == kReturn then
        commit_unconfirmed(context, env)
        context:set_option("_kagiroi_ascii_input", false)
        return kAccepted
    end

    if keycode == kBackSpace then
        delete_last_character(context, env)
        return kAccepted
    end

    if keycode == kEscape then
        keep_display_for_editing(context, env)
        context.input = ""
        finish_deletion(context)
        return kAccepted
    end

    if env.conversion and not context:get_option("_kagiroi_hide_candidates")
        and (keycode == kUp or keycode == kDown) then
        bunsetsu.select(context, keycode == kUp and -1 or 1, true)
        context:set_option("_kagiroi_ascii_input", false)
        context:set_option("_kagiroi_off_pending", false)
        kana_speller.ascii_tail = nil
        bunsetsu.render(context)
        return kAccepted
    end

    return kNoop
end

function Top.func(key_event, env)
    local context = env.engine.context
    env.conversion = bunsetsu.state(context)
    if key_event.keycode == 0xffe1 then return kNoop end
    if context:get_option("ascii_mode") then
        return kNoop
    end
    if listed_shortcut(key_event) then
        return kRejected
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

    if is_plain_letter(keycode) and key_event:shift() then
        keep_display_for_editing(context, env)
        Top.start_ascii_input(context)
        return Top.ascii_func(key_event, env)
    end

    if not in_conversion and (is_plain_letter(keycode) or keycode == kMinus) then
        prepare_append(context)
    end

    -- A letter during conversion confirms the unconfirmed string and the
    -- pressed key starts the next reading (dotfiles/rime/SPEC.md).
    if in_conversion and is_plain_letter(keycode) then
        commit_unconfirmed(context, env)
        return kana_speller.func(key_event, env)
    end

    -- Digits, symbols, punctuation and keypad character keys during
    -- conversion follow the same contract: commit the whole displayed
    -- composition, then start the next input with the pressed key's
    -- character (dotfiles/rime/SPEC.md, "確定と次入力").
    local append = appended_text(keycode, in_conversion)
    if append then
        if in_conversion then
            commit_unconfirmed(context, env)
        end
        prepare_append(context)
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
        context:set_option("_kagiroi_off_pending", false)
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
        finish_deletion(context)
        return kAccepted
    end

    if composing and keycode == kBackSpace then
        delete_last_character(context, env)
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
                context:set_option("_kagiroi_off_pending", false)
                bunsetsu.render(context)
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
