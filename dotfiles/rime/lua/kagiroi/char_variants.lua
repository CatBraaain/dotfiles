-- Character-type candidates for unconfirmed strings that carry no reading
-- (dotfiles/rime/SPEC.md, "変換"): a segment made of digits, symbols,
-- punctuation or half-width letters converts to itself, and segments with
-- ASCII or full-width alphanumerics also offer their full-width, half-width
-- and letter-case forms. Segments that contain kana keep the stock
-- translator's candidates untouched; mixed strings follow the existing
-- conversion processing segment by segment.
local Top = {}

-- Hiragana and katakana blocks, including the long vowel mark: segments with
-- these characters have a reading the stock translator owns.
local function has_kana(text)
    for _, codepoint in utf8.codes(text) do
        if codepoint >= 0x3040 and codepoint <= 0x30ff then
            return true
        end
    end
    return false
end

local function is_alnum(codepoint)
    return (codepoint >= 0x30 and codepoint <= 0x39)
        or (codepoint >= 0x41 and codepoint <= 0x5a)
        or (codepoint >= 0x61 and codepoint <= 0x7a)
        or (codepoint >= 0xff10 and codepoint <= 0xff19)
        or (codepoint >= 0xff21 and codepoint <= 0xff3a)
        or (codepoint >= 0xff41 and codepoint <= 0xff5a)
end

local function is_letter(codepoint)
    return (codepoint >= 0x41 and codepoint <= 0x5a)
        or (codepoint >= 0x61 and codepoint <= 0x7a)
        or (codepoint >= 0xff21 and codepoint <= 0xff3a)
        or (codepoint >= 0xff41 and codepoint <= 0xff5a)
end

local function has(text, predicate)
    for _, codepoint in utf8.codes(text) do
        if predicate(codepoint) then
            return true
        end
    end
    return false
end

-- Half-width forms map to their full-width counterparts and back; every
-- other character keeps its form.
local function width(codepoint, to_full)
    if to_full then
        if codepoint >= 0x21 and codepoint <= 0x7e then
            return codepoint + 0xfee0
        end
    elseif codepoint >= 0xff01 and codepoint <= 0xff5e then
        return codepoint - 0xfee0
    end
    return codepoint
end

local function case(codepoint, to_upper)
    if to_upper then
        if (codepoint >= 0x61 and codepoint <= 0x7a)
            or (codepoint >= 0xff41 and codepoint <= 0xff5a) then
            return codepoint - 0x20
        end
    elseif (codepoint >= 0x41 and codepoint <= 0x5a)
        or (codepoint >= 0xff21 and codepoint <= 0xff3a) then
        return codepoint + 0x20
    end
    return codepoint
end

local function map_characters(text, mapper)
    local characters = {}
    for _, codepoint in utf8.codes(text) do
        characters[#characters + 1] = utf8.char(mapper(codepoint))
    end
    return table.concat(characters)
end

function Top.func(input, seg, env)
    if type(seg.has_tag) == "function" and (seg:has_tag("bunsetsu_fixed") or seg:has_tag("bunsetsu_active")) then
        return
    end
    if type(seg.start) ~= "number" or type(seg._end) ~= "number" then
        return
    end
    local text = input:sub(1, seg._end - seg.start)
    -- Translators are also probed with raw binary keys; only valid UTF-8
    -- text carries character-type candidates.
    if text == "" or not utf8.len(text) or has_kana(text) then
        return
    end
    local offered = {}
    local function offer(candidate_text)
        if candidate_text ~= "" and not offered[candidate_text] then
            offered[candidate_text] = true
            yield(Candidate("kagiroi_ascii", seg.start, seg._end, candidate_text, ""))
        end
    end
    -- The original text is the first candidate: strings without a reading
    -- convert to themselves (dotfiles/rime/SPEC.md).
    offer(text)
    if not has(text, is_alnum) then
        return
    end
    offer(map_characters(text, function(codepoint)
        return width(codepoint, true)
    end))
    offer(map_characters(text, function(codepoint)
        return width(codepoint, false)
    end))
    if not has(text, is_letter) then
        return
    end
    offer(map_characters(text, function(codepoint)
        return case(codepoint, true)
    end))
    offer(map_characters(text, function(codepoint)
        return case(codepoint, false)
    end))
end

return Top
