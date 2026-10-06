local kAccepted = 1
local kNoop = 2
local romaji_to_kana = {}
for line in io.lines(arg[3]) do
    local kana, roma = line:match("^([^\t]+)\t([^\t]+)\t1$")
    if roma then romaji_to_kana[roma] = kana end
end
assert(romaji_to_kana.nn == "ん" and romaji_to_kana.tt == "っt", "use the generated dictionary")
local rules = dofile(arg[2])
package.preload["kagiroi/zenkaku_rules"] = function() return rules end

local base = {}
function base.init(env)
    env.alphabet = "abcdefghijklmnopqrstuvwxyz-;"
    env.prefix = ""
    env.roma2hira_xlator = true
end
function base.fini() end
function base.func(key_event, env)
    if key_event.keycode == 0x20 or key_event.keycode > 0x7E then
        return kNoop
    end

    local context = env.engine.context
    local input = context.input
    local suffix = input:match("([a-z%-;]*)$") or ""
    local spelling = suffix .. string.char(key_event.keycode)
    local kana = romaji_to_kana[spelling]
    if not kana then
        return kNoop
    end

    context:pop_input(#suffix)
    context:push_input(kana)
    return kAccepted
end

function base.query_roma2hira_xlator(suffix, env)
    local kana = romaji_to_kana[suffix]
    return kana and { text = kana, _end = #suffix } or nil
end

package.preload["kagiroi/kagiroi_kana_speller"] = function()
    return base
end

local processor = dofile(arg[1])

local function new_environment()
    local context = { input = "", caret_pos = 0 }
    context.options = {}
    function context:get_option(name) return self.options[name] or false end
    local composition = {}
    function composition:back()
        if context.input == "" then
            return nil
        end
        return {
            start = 0,
            _end = #context.input,
            has_tag = function(_, tag)
                return tag == "kagiroi"
            end,
        }
    end
    function context:pop_input(length)
        self.caret_pos = self.caret_pos - length
        rawset(self, "input",
            self.input:sub(1, self.caret_pos) .. self.input:sub(self.caret_pos + length + 1))
    end
    function context:push_input(text)
        rawset(self, "input",
            self.input:sub(1, self.caret_pos) .. text .. self.input:sub(self.caret_pos + 1))
        self.caret_pos = self.caret_pos + #text
    end
    context.composition = composition
    -- Mirror librime's set_input: assigning input moves the caret to the end.
    setmetatable(context, {
        __newindex = function(table, key, value)
            rawset(table, key, value)
            if key == "input" then
                rawset(table, "caret_pos", #value)
            end
        end,
    })

    return {
        engine = { context = context },
        context = context,
        alphabet = "abcdefghijklmnopqrstuvwxyz-;",
        prefix = "",
    }
end

local function press_key(env, keycode)
    local key_event = {
        keycode = keycode,
        release = function() return false end,
        ctrl = function() return false end,
        alt = function() return false end,
        super = function() return false end,
    }
    return processor.func(key_event, env)
end

local function press(env, character)
    local result = press_key(env, character:byte())
    if result == kNoop and character ~= " " then
        env.context:push_input(character)
    end
    return result
end

local function type_text(text)
    local env = new_environment()
    processor.ascii_tail = nil
    processor.init(env)
    for character in text:gmatch(".") do
        press(env, character)
    end
    return env.context.input
end

-- SPEC: the reading shown while typing.
local typing_cases = {
    { input = "kannnni", expected = "かんに" },
    { input = "kannnne", expected = "かんね" },
    { input = "kannnno", expected = "かんの" },
    { input = "nnnn", expected = "んん" },
    { input = "sammmma", expected = "さんな" },
    { input = "nt", expected = "んt" },
    { input = "mt", expected = "んt" },
    { input = "nm", expected = "んm" },
    { input = "mn", expected = "んn" },
    { input = "nma", expected = "んま" },
    { input = "mna", expected = "んな" },
    { input = "kk", expected = "っk" },
    { input = "kc", expected = "っc" },
    { input = "ck", expected = "っk" },
    { input = "cka", expected = "っか" },
    { input = "kca", expected = "っか" },
    { input = "mm", expected = "ん" },
    { input = "ma", expected = "ま" },
    { input = "mya", expected = "みゃ" },
    { input = "nn", expected = "ん" },
    { input = "gennin", expected = "げんいn" },
    { input = "nnin", expected = "んいn" },
    { input = "ni", expected = "に" },
    { input = "i", expected = "い" },
    { input = "kan", expected = "かn" },
    { input = "kann", expected = "かん" },
    { input = "nna", expected = "んあ" },
    { input = "nnyo", expected = "んよ" },
    { input = "kanji", expected = "かんじ" },
    { input = "kannji", expected = "かんじ" },
    { input = "kannnji", expected = "かんんじ" },
    { input = "kannnnji", expected = "かんんじ" },
    { input = "kannnnu", expected = "かんぬ" },
    { input = "kannnnyo", expected = "かんんよ" },
    { input = "kana", expected = "かな" },
    { input = "kanna", expected = "かんあ" },
    { input = "kannna", expected = "かんな" },
    { input = "kannnna", expected = "かんな" },
    { input = "konitiha", expected = "こにちは" },
    { input = "konnnitiha", expected = "こんにちは" },
    { input = "kanda", expected = "かんだ" },
    { input = "kannda", expected = "かんだ" },
    { input = "kannnda", expected = "かんんだ" },
    { input = "kannnen", expected = "かんねn" },
    { input = "kannnnen", expected = "かんねn" },
    { input = "nya", expected = "にゃ" },
    { input = "nwa", expected = "んわ" },
    { input = "nwi", expected = "んうぃ" },
    { input = "nwe", expected = "んうぇ" },
    { input = "nwo", expected = "んを" },
    { input = "nnwa", expected = "んわ" },
    { input = "kan-", expected = "かnー" },
    { input = "tt", expected = "っt" },
    { input = "tta", expected = "った" },
    { input = "kkha", expected = "っきゃ" },
    { input = "kkka", expected = "っっか" },
    -- m behaves exactly like n: a consonant or the doubled pair reads ん,
    -- a lone letter before a vowel keeps its own row
    { input = "samba", expected = "さんば" },
    { input = "samma", expected = "さんあ" },
    { input = "mma", expected = "んあ" },
    { input = "mk", expected = "んk" },
    { input = "mann", expected = "まん" },
}

for _, case in ipairs(typing_cases) do
    local actual = type_text(case.input)
    assert(actual == case.expected, case.input .. ": expected " .. case.expected .. ", got " .. actual)
end

-- SPEC: the reading used when Space converts.
local conversion_cases = {
    { input = "kam", expected = "かん" },
    { input = "nnnn", expected = "んん" },
    { input = "nn", expected = "ん" },
    { input = "gennin", expected = "げんいん" },
    { input = "nnin", expected = "んいん" },
    { input = "kann", expected = "かん" },
    { input = "kan", expected = "かん" },
    { input = "kanji", expected = "かんじ" },
    { input = "kannji", expected = "かんじ" },
    { input = "kannnji", expected = "かんんじ" },
    { input = "kannnnji", expected = "かんんじ" },
    { input = "kana", expected = "かな" },
    { input = "nya", expected = "にゃ" },
    { input = "nna", expected = "んあ" },
    { input = "nnyo", expected = "んよ" },
    { input = "kanna", expected = "かんあ" },
    { input = "kannna", expected = "かんな" },
    { input = "kannnna", expected = "かんな" },
    { input = "kannnni", expected = "かんに" },
    { input = "kannnnu", expected = "かんぬ" },
    { input = "kannnne", expected = "かんね" },
    { input = "kannnno", expected = "かんの" },
    { input = "kannnnyo", expected = "かんんよ" },
    { input = "konnnitiha", expected = "こんにちは" },
    { input = "kanda", expected = "かんだ" },
    { input = "kannda", expected = "かんだ" },
    { input = "kannnda", expected = "かんんだ" },
    { input = "kannnen", expected = "かんねん" },
    { input = "kannnnen", expected = "かんねん" },
    { input = "nwa", expected = "んわ" },
    { input = "nwi", expected = "んうぃ" },
    { input = "nwe", expected = "んうぇ" },
    { input = "nwo", expected = "んを" },
    -- Space resolves only pending n/m; conditional substitutions are already displayed.
    { input = "tt", expected = "っt" },
    { input = "samba", expected = "さんば" },
    { input = "samma", expected = "さんあ" },
    { input = "mann", expected = "まん" },
    { input = "sammmma", expected = "さんな" },
}

for _, case in ipairs(conversion_cases) do
    local env = new_environment()
    processor.init(env)
    for character in case.input:gmatch(".") do
        press(env, character)
    end
    press(env, " ")
    local actual = env.context.input
    assert(actual == case.expected,
        case.input .. " + Space: expected " .. case.expected .. ", got " .. actual)
end

local env = new_environment()
processor.init(env)
press(env, "n")
press(env, " ")
assert(env.context.input == "ん", "n followed by Space should become ん")

-- SPEC: the conversion-time correction treats the whole reading, whatever
-- the caret position (Left may move it away from the end).
env = new_environment()
processor.init(env)
for character in ("kan"):gmatch(".") do press(env, character) end
env.context.caret_pos = #"か"
press(env, " ")
assert(env.context.input == "かん",
    "Space with a mid-input caret must still resolve the trailing n")

env = new_environment()
processor.init(env)
for character in ("kannnna"):gmatch(".") do press(env, character) end
env.context.caret_pos = #"かん"
press(env, " ")
assert(env.context.input == "かんな",
    "Space with a mid-input caret must preserve the input-time replacement")

-- The long-vowel key is not a consonant: the n ahead of it stays pending and
-- the conversion does not complete an n that is no longer trailing.
env = new_environment()
processor.init(env)
for character in ("kan-"):gmatch(".") do press(env, character) end
assert(env.context.input == "かnー", "kan- must keep the pending n raw")
press(env, " ")
assert(env.context.input == "かnー", "Space must not complete a non-trailing n")

env = new_environment()
processor.init(env)
env.context:push_input("かn")
env.context.caret_pos = #"か"
press(env, "j")
assert(env.context.input == "かjn", "middle-of-input typing must not delete text before the caret")

-- SPEC: nn is consumed on the second keypress; the following vowel
-- receives no implicit n, and a new final n stays pending.
env = new_environment()
processor.init(env)
press(env, "n")
assert(env.context.input == "n", "a lone n must stay pending while typing")
press(env, "n")
assert(env.context.input == "ん", "nn must become ん on the second keypress")
press(env, "i")
assert(env.context.input == "んい", "i after the consumed nn must stay い")
press(env, "n")
assert(env.context.input == "んいn", "a new final n must stay pending")

-- A lone ん that did not come from an nn pair stays unchanged too.
env = new_environment()
processor.init(env)
env.context:push_input("ん")
press(env, "a")
assert(env.context.input == "んあ", "a vowel after a foreign ん must not rebind")

-- The fixed ascii tail: characters appended in the ascii input mode stay
-- half-width and fixed, while typing after them converts as usual
-- (dotfiles/rime/SPEC.md).
env = new_environment()
processor.init(env)
env.context:push_input("こんにちは")
processor.ascii_tail = #env.context.input
press(env, "k")
assert(env.context.input == "こんにちはk", "a letter after the tail must be appended unconverted")
-- The tail follows the appended half-width text, as rime_controls does.
processor.ascii_tail = #env.context.input
press(env, "a")
assert(env.context.input == "こんにちはkあ", "typing after the tail must convert behind it")
press(env, "n")
assert(env.context.input == "こんにちはkあn", "a pending n behind the tail stays raw")
press(env, "a")
assert(env.context.input == "こんにちはkあな", "the n correction must work behind the tail")

-- A tail ending with n must not be picked up by the n correction.
env = new_environment()
processor.init(env)
env.context:push_input("こんにちはn")
processor.ascii_tail = #env.context.input
press(env, "a")
assert(env.context.input == "こんにちはnあ", "the tail n must stay fixed while the vowel converts")
press(env, "k")
press(env, "a")
assert(env.context.input == "こんにちはnあか", "typing must keep converting after the tail")

-- Bare んん survives until the declared full literal is completed.
env = new_environment()
processor.ascii_tail = nil
processor.init(env)
for character in ("nnnn"):gmatch(".") do press(env, character) end
assert(env.context.input == "んん", "bare んん must not collapse")
press(env, "a")
assert(env.context.input == "んな", "the following vowel completes the literal")

for _, option in ipairs({ "ascii_mode", "_kagiroi_ascii_input" }) do
    env = new_environment()
    processor.ascii_tail = nil
    processor.init(env)
    env.context:push_input("んん")
    env.context.options[option] = true
    press(env, "a")
    assert(env.context.input == "んんa", option .. " must bypass romaji and postroma")
    processor.resolve_conversion(env)
    assert(env.context.input == "んんa", option .. " must bypass the finalizer")
end

-- The frozen display and its boundary cannot participate in a replacement.
env = new_environment()
processor.init(env)
env.context:push_input("んん")
processor.ascii_tail = #env.context.input
press(env, "a")
assert(env.context.input == "んんあ", "postroma must not cross the frozen boundary")
for character in ("nnnna"):gmatch(".") do press(env, character) end
assert(env.context.input == "んんあんな", "postroma must still process resumed reading")

-- Seed unmatched history directly: conversion/Enter must not run postroma.
processor.ascii_tail = nil
for _, keycode in ipairs({ 0x20, 0xff23, 0xff0d }) do
    env = new_environment()
    processor.init(env)
    env.context:push_input("んんあ")
    press_key(env, keycode)
    assert(env.context.input == "んんあ", "control keys must not run postroma")
end

-- Synthetic declaration-ordered processors exercise literal/global/bounded passes.
local declared = rules.postroma
rules.postroma = {
    { replace = { { "んんあ", "あ.%" } } },
    { replace = { { "あ.%", "い" } } },
}
env = new_environment()
processor.init(env)
env.context:push_input("んんあんん")
press(env, "a")
assert(env.context.input == "いい", "all literal matches must run in processor order")
rules.postroma = { { replace = { { "あ", "ああ" } } } }
env = new_environment()
processor.init(env)
press(env, "a")
assert(env.context.input == "ああ", "replacement output must not feed a fixed-point loop")
-- A raw pending key after the frozen boundary is handled, but not converted.
env = new_environment()
processor.init(env)
processor.ascii_tail = 0
press(env, "a")
press(env, "k")
assert(env.context.input == "ああk", "pending romaji must not reprocess prior kana")
processor.ascii_tail = nil
rules.postroma = declared

print("Kagiroi declaration-driven kana-speller transition tests passed")
