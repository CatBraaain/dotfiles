-- Typing-time and conversion-time correction of n runs, wrapping the stock
-- Kagiroi kana speller (dotfiles/rime/SPEC.md, "n の過不足補完").
-- Pair: the second n of a run converts to ん immediately through the
-- declaration's nn spelling; a vowel on the very next key rebinds that ん
-- as ん+n (kanna -> かんな). Insufficient n: a lone pending n becomes ん
-- when a consonant key or a conversion key follows. Excessive n: not
-- corrected while typing; at conversion, consecutive ん fold into one and
-- one leftover ん binds with a following vowel as the next syllable's n.
local kAccepted = 1
local kNoop = 2
local base = require("kagiroi/kagiroi_kana_speller")
local Top = { init = base.init, fini = base.fini }
-- The input byte position where the half-width text appended in the ascii
-- input mode starts. rime_controls records and clears it, and the reading
-- continues only from the trailing run behind the tail
-- (dotfiles/rime/SPEC.md).
Top.ascii_tail = nil

local n_kana = "ん"
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
    local suffix = get_alphabet_suffix(segment_text, env.alphabet)
    local tail = Top.ascii_tail
    if tail then
        -- The tail is the end position of the fixed half-width text: the
        -- reading continues from the trailing run behind it. A commit or
        -- deletes elsewhere may have shortened the input past the tail; the
        -- fixed text is gone then.
        if tail > #context.input then
            Top.ascii_tail = nil
        else
            local cut = tail - (#context.input - #suffix)
            if cut >= #suffix then
                suffix = ""
            elseif cut > 0 then
                suffix = suffix:sub(cut + 1)
            end
        end
    end
    return context, suffix
end

local function replace_pending_n(context, pending_n, replacement)
    context:pop_input(#pending_n)
    context:push_input(replacement)
end

-- True when the input ends with a ん that is not preceded by another ん:
-- the reading a fresh nn pair leaves behind, and the only one a vowel may
-- rebind (a んん run from nnnn stays put).
local function ends_with_lone_pair_n(input)
    return input:sub(-3) == n_kana and input:sub(-6, -4) ~= n_kana
end

-- A consonant or a conversion key after the run: fold the run into pairs and
-- complete a leftover single n as ん (kanji -> かんじ, nwa -> んわ).
local function n_run_before_consonant(count)
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
    local pending_n = remaining_alphabet:match("n+$")
    if pending_n then
        replace_pending_n(context, pending_n, n_run_before_consonant(#pending_n))
    end
    local folded = fold_n_runs(context.input)
    if folded ~= context.input then
        context.input = folded
    end
end

-- Typing with the fixed ascii tail: the stock speller must not see the
-- input, because its trailing run would join the tail characters to the
-- reading. The key is pushed here, and only the suffix after the tail is
-- converted to kana.
local function spell_after_tail(key_event, env)
    local context, remaining_alphabet = get_context(env)
    if not context then
        return kNoop
    end
    local character = string.char(key_event.keycode)
    context:push_input(character)
    local spelling = remaining_alphabet .. character
    -- The longest suffix, the whole run included, wins: the stock speller is
    -- not consulted while the tail is fixed. The key is already pushed, so
    -- the whole matched suffix is replaced.
    for start = 1, #spelling do
        local suffix = spelling:sub(start)
        local candidate = base.query_roma2hira_xlator(suffix, env)
        if candidate and candidate._end == #suffix then
            context:pop_input(#suffix)
            context:push_input(candidate.text)
            break
        end
    end
    return kAccepted
end

local function spell_with_suffix(key_event, env)
    if Top.ascii_tail then
        return spell_after_tail(key_event, env)
    end
    local result = base.func(key_event, env)
    if result ~= kNoop then
        return result
    end

    local character = string.char(key_event.keycode)
    if not env.alphabet:find(character, 1, true) then
        return result
    end
    local context, remaining_alphabet = get_context(env)
    if not context or not env.roma2hira_xlator then
        return result
    end

    local spelling = remaining_alphabet .. character
    for start = 2, #spelling do
        local suffix = spelling:sub(start)
        local candidate = base.query_roma2hira_xlator(suffix, env)
        if candidate and candidate._end == #suffix then
            context:pop_input(#suffix - 1)
            context:push_input(candidate.text)
            return kAccepted
        end
    end
    return result
end

function Top.func(key_event, env)
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return base.func(key_event, env)
    end

    -- The pair marker survives only until the next key press; releases and
    -- modifier combos keep it.
    local pair_rebindable = env.nn_pair_pending
    env.nn_pair_pending = false

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
        -- A trailing pending n turns this key into the declaration's nn
        -- spelling: convert the pair to ん now, including after a raw prefix.
        -- A run never holds more than one raw n, so no other case exists.
        if remaining_alphabet:sub(-1) == "n" then
            local result = spell_with_suffix(key_event, env)
            if result == kAccepted then
                env.nn_pair_pending = true
            end
            return result
        end
        return kNoop
    end

    local pending_n = remaining_alphabet:match("n+$")
    if not pending_n then
        -- A vowel directly after a fresh nn pair rebinds its ん as ん+n so
        -- the base speller can bind the vowel (kanna -> かんな). んん from a
        -- longer run and ん without the pair marker stay as they are.
        if vowels[character]
            and pair_rebindable
            and ends_with_lone_pair_n(context.input)
            and env.alphabet:find(character, 1, true)
        then
            context:push_input("n")
        end
        return spell_with_suffix(key_event, env)
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
        local replacement = n_run_before_consonant(#pending_n)
        if replacement ~= pending_n then
            replace_pending_n(context, pending_n, replacement)
        end
    end

    return spell_with_suffix(key_event, env)
end

return Top
