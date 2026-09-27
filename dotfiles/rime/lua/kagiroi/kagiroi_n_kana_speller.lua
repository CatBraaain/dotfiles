local kNoop = 2
local base = require("kagiroi/kagiroi_kana_speller")
local Top = { init = base.init, fini = base.fini }

local vowels = { a = true, e = true, i = true, o = true, u = true, y = true }

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

function Top.func(key_event, env)
    if key_event:release() or key_event:ctrl() or key_event:alt() or key_event:super() then
        return base.func(key_event, env)
    end

    local keycode = key_event.keycode
    if keycode < 0x20 or keycode > 0x7E then
        return base.func(key_event, env)
    end

    local character = string.char(keycode)
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

    if character == " " then
        replace_pending_n(context, pending_n, "ん")
        return base.func(key_event, env)
    end

    if not env.alphabet:find(character, 1, true) then
        return base.func(key_event, env)
    end

    if vowels[character] then
        if #pending_n > 1 then
            replace_pending_n(context, pending_n, "んn")
        end
    else
        replace_pending_n(context, pending_n, "ん")
    end

    return base.func(key_event, env)
end

return Top
