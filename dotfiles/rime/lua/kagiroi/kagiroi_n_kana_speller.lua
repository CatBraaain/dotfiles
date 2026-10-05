-- Declaration-driven romaji conversion and input-time literal replacements.
local kAccepted = 1
local kNoop = 2
local base = require("kagiroi/kagiroi_kana_speller")
local rules = require("kagiroi/romaji_rules")
local Top = { init = base.init, fini = base.fini }
-- Byte boundary of the frozen display; only resumed input after it is read.
Top.ascii_tail = nil

local function is_ascii(context)
    return context:get_option("ascii_mode") or context:get_option("_kagiroi_ascii_input")
end

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

-- The trailing alphabet run the pending finalizer works on: the run behind
-- the fixed ascii tail, or the run inside the last kagiroi segment.
-- Independent of the caret, so the conversion-time correction can treat the
-- whole reading.
local function trailing_alphabet(env)
    local context = env.engine.context

    -- The fixed half-width tail spans segment boundaries (uppercase letters
    -- and digits are not reading alphabet), so the resumed run is taken from
    -- the whole input instead of the last segment.
    local tail = Top.ascii_tail
    if tail then
        if tail > #context.input then
            Top.ascii_tail = nil
            return context, ""
        end
        local suffix = get_alphabet_suffix(context.input, env.alphabet)
        local cut = tail - (#context.input - #suffix)
        if cut >= #suffix then
            suffix = ""
        elseif cut > 0 then
            suffix = suffix:sub(cut + 1)
        end
        return context, suffix
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
    return context, suffix
end

local function get_context(env)
    local context = env.engine.context
    if context.caret_pos ~= #context.input then
        return nil
    end
    return trailing_alphabet(env)
end

-- Space/Henkan complete only the final pending consonant, independently
-- of postroma. The build derives these letters from doubled singles -> ん.
function Top.resolve_conversion(env)
    if is_ascii(env.engine.context) then return end
    local context, remaining_alphabet = trailing_alphabet(env)
    if not context then return end
    local replacement = rules.pending[remaining_alphabet:sub(-1)]
    if replacement then
        context.input = context.input:sub(1, -2) .. replacement
    end
end

local function replace_literal(text, from, to)
    local parts = {}
    local cursor = 1
    while true do
        local first, last = text:find(from, cursor, true)
        if not first then break end
        parts[#parts + 1] = text:sub(cursor, first - 1)
        parts[#parts + 1] = to
        cursor = last + 1
    end
    parts[#parts + 1] = text:sub(cursor)
    return table.concat(parts)
end

local function postroma(context)
    local boundary = Top.ascii_tail or 0
    local reading = context.input:sub(boundary + 1)
    local replaced = reading
    for _, processor in ipairs(rules.postroma) do
        for _, substitution in ipairs(processor.replace) do
            replaced = replace_literal(replaced, substitution[1], substitution[2])
        end
    end
    if replaced ~= reading then
        context:pop_input(#reading)
        context:push_input(replaced)
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
            return kAccepted, true
        end
    end
    return kAccepted, false
end

local function spell_with_suffix(key_event, env)
    if Top.ascii_tail then
        return spell_after_tail(key_event, env)
    end
    local result = base.func(key_event, env)
    if result ~= kNoop then
        return result, result == kAccepted
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
            return kAccepted, true
        end
    end
    return result
end

function Top.func(key_event, env)
    local context = env.engine.context
    if is_ascii(context) then return kNoop end
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
        return kNoop
    end
    if not env.alphabet:find(character, 1, true) then
        return base.func(key_event, env)
    end
    if not get_context(env) then return kNoop end
    local result, converted = spell_with_suffix(key_event, env)
    if converted then postroma(context) end
    return result
end

return Top
