-- Character-type candidate coverage for the char_variants translator
-- (dotfiles/rime/SPEC.md, "変換"): segments without a reading offer the
-- original text plus the width and case forms of their alphanumerics, and
-- kana segments offer nothing so the stock translator stays in charge.
local offered = {}
_G.yield = function(candidate)
    offered[#offered + 1] = candidate.text
end
_G.Candidate = function(candidate_type, start, pos, text, comment)
    return { text = text, type = candidate_type, comment = comment }
end

local translator = dofile(arg[1])

local function run(text)
    offered = {}
    translator.func(text, { start = 0, _end = #text }, {})
    return offered
end

local function assert_texts(text, expected)
    local actual = run(text)
    assert(#actual == #expected,
        text .. ": expected " .. #expected .. " candidates, got " .. #actual
            .. " (" .. table.concat(actual, ",") .. ")")
    for index = 1, #expected do
        assert(actual[index] == expected[index],
            text .. ": candidate " .. index .. " must be " .. expected[index]
                .. ", got " .. tostring(actual[index]))
    end
end

-- Half-width letters: the original, the full-width form and the case forms.
assert_texts("abc", { "abc", "ａｂｃ", "ABC" })
assert_texts("ABC", { "ABC", "ＡＢＣ", "abc" })
assert_texts("A1b", { "A1b", "Ａ１ｂ", "A1B", "a1b" })

-- Digits swap their width only.
assert_texts("123", { "123", "１２３" })
assert_texts("１２３", { "１２３", "123" })

-- Mixed widths: the width and case forms keep each character's own width.
assert_texts("Ａｂc", { "Ａｂc", "Ａｂｃ", "Abc", "ＡＢC", "ａｂc" })

-- Symbols and punctuation offer only the original text.
assert_texts("＄", { "＄" })
assert_texts("、", { "、" })
assert_texts("，", { "，" })

-- Kana segments and empty text offer nothing: the stock translator owns
-- their candidates.
assert_texts("かな", {})
assert_texts("カンジ", {})
assert_texts("", {})

-- Invalid UTF-8 probes (dictionary key lookups) must not offer candidates
-- and must not error.
assert_texts("\xff\xfe", {})

print("Rime char variants translator tests passed")
