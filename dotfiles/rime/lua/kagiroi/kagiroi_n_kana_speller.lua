-- Typing-time and conversion-time correction of n runs, wrapping the stock
-- Kagiroi kana speller (dotfiles/rime/SPEC.md, "n の過不足補完").
-- Insufficient n: a lone pending n becomes ん when a consonant key or a
-- conversion key follows. Excessive n: not corrected while typing; at
-- conversion, consecutive ん fold into one and one leftover ん binds with a
-- following vowel as the next syllable's n.
local kNoop = 2
local base = require("kagiroi/kagiroi_kana_speller")
local Top = { init = base.init, fini = base.fini }

local vowels = { a = true, e = true, i = true, o = true, u = true, y = true }

-- Kana a leftover ん can bind with: the kana spelled with a leading n plus a
-- vowel (a i u e o y in the SPEC).
local n_bindable_vowels = {
    ["あ"] = "な",
    ["い"] = "に",
    ["う"] = "ぬ",
    ["え"] = "ね",
    ["お"] = "の",
    ["や"] = "にゃ",
    ["ゆ"] = "にゅ",
    ["よ"] = "にょ",
}

local function get_alphabet_suffix(text, alphabet)
    local suffix = ""
    for index = #text, 1, -1 do
        local character = text:sub(index, index)
        if alphabet:find(character, 1, true) then
            suffix = character .. suffix
        else
            break
        end
    end
    return suffix
end

local function get_context(env)
    local context = env.engine.context
    if context.caret_pos ~= #context.input then
        return nil
    end

    local last_segment = context.composition:back()
    if not last_segment then
        if env.prefix ~= "" then
            return nil
        end
        return context, ""
    end

    if not last_segment:has_tag("kagiroi") then
        if last_segment.start ~= 0 or context.input ~= env.prefix then
            return nil
        end
        return context, ""
    end

    local segment_text = context.input:sub(last_segment.start + 1, last_segment._end)
    return context, get_alphabet_suffix(segment_text, env.alphabet)
end

local function replace_pending_n(context, pending_n, replacement)
    context:pop_input(#pending_n)
    context:push_input(replacement)
end

-- A consonant or a conversion key after the run: fold the run into pairs and
-- complete a leftover single n as ん (kanji -> かんじ, kannnji -> かんんじ).
-- A lone n followed by w keeps its place as the consonant of the
-- declaration's nw spellings (nwa -> ぬぁ); ん + わ is nnwa.
local function n_run_before_consonant(count, character)
    if count == 1 and character == "w" then
        return "n"
    end
    return ("ん"):rep(math.ceil(count / 2))
end

-- A vowel key after the run: short runs keep one ん and let the last n
-- bind with the vowel (kanna and kannna -> かんな), while runs of four or
-- more n's fold pairwise without binding (kannnna -> かんんあ). An odd count
-- always leaves the last n free for the binding.
local function n_run_before_vowel(count)
    local replacement = ("ん"):rep(math.floor(count / 2))
    if count == 2 or count % 2 == 1 then
        return replacement .. "n"
    end
    return replacement
end

-- Conversion-time reading: collapse every run of consecutive ん into a single
-- ん, and when a bindable vowel kana follows the run, consume one leftover ん
-- as the next syllable's n (かんんあ -> かんな, かんんえ -> かんね).
local function fold_n_runs(text)
    local characters = {}
    for _, codepoint in utf8.codes(text) do
        characters[#characters + 1] = utf8.char(codepoint)
    end

    local folded = {}
    local index = 1
    while index <= #characters do
        local character = characters[index]
        if character ~= "ん" then
            folded[#folded + 1] = character
            index = index + 1
        else
            local run_end = index
            while characters[run_end + 1] == "ん" do
                run_end = run_end + 1
            end
            folded[#folded + 1] = "ん"
            local bound = run_end > index and n_bindable_vowels[characters[run_end + 1]]
            if bound then
                folded[#folded + 1] = bound
                index = run_end + 2
            else
                index = run_end + 1
            end
        end
    end
    return table.concat(folded)
end

-- Resolve the trailing pending n and fold consecutive ん across the whole
-- input for conversion (Space / Henkan). No-op unless the caret sits at the
-- end of the kagiroi input.
function Top.resolve_conversion(env)
    local context, remaining_alphabet = get_context(env)
    if not context then
        return
    end
    local pending_n = remaining_alphabet:match("^n+$")
    if pending_n then
        replace_pending_n(context, pending_n, n_run_before_consonant(#pending_n))
    end
    local folded = fold_n_runs(context.input)
    if folded ~= context.input then
        context.input = folded
    end
end

function Top.func(key_event, env)
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return base.func(key_event, env)
    end

    local keycode = key_event.keycode
    if keycode < 0x20 or keycode > 0x7E then
        return base.func(key_event, env)
    end

    local character = string.char(keycode)
    if character == " " then
        Top.resolve_conversion(env)
        return base.func(key_event, env)
    end

    local context, remaining_alphabet = get_context(env)
    if not context then
        return base.func(key_event, env)
    end

    if character == "n" then
        return kNoop
    end

    local pending_n = remaining_alphabet:match("^n+$")
    if not pending_n then
        return base.func(key_event, env)
    end

    if not env.alphabet:find(character, 1, true) then
        return base.func(key_event, env)
    end

    if vowels[character] then
        local replacement = n_run_before_vowel(#pending_n)
        if replacement ~= pending_n then
            replace_pending_n(context, pending_n, replacement)
        end
    else
        local replacement = n_run_before_consonant(#pending_n, character)
        if replacement ~= pending_n then
            replace_pending_n(context, pending_n, replacement)
        end
    end

    return base.func(key_event, env)
end

return Top
