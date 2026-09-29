local kAccepted = 1
local kNoop = 2
local kBackSpace = 0xff08
local romaji_to_kana = {
    ko = "こ",
    ka = "か",
    na = "な",
    ni = "に",
    ji = "じ",
    chi = "ち",
    ti = "ち",
    da = "だ",
    de = "で",
    ha = "は",
    nya = "にゃ",
    nyo = "にょ",
    ne = "ね",
    e = "え",
    a = "あ",
    nn = "ん",
    nwa = "ぬぁ",
    wa = "わ",
}

local base = {}
function base.init(env)
    env.alphabet = "abcdefghijklmnopqrstuvwxyz-;"
    env.prefix = ""
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

package.preload["kagiroi/kagiroi_kana_speller"] = function()
    return base
end

local processor = dofile(arg[1])

local function new_environment()
    local context = { input = "", caret_pos = 0 }
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
    processor.init(env)
    for character in text:gmatch(".") do
        press(env, character)
    end
    return env.context.input
end

-- SPEC: the reading shown while typing.
local typing_cases = {
    { input = "nn", expected = "ん" },
    { input = "kan", expected = "かn" },
    { input = "kann", expected = "かん" },
    { input = "nna", expected = "んな" },
    { input = "nnyo", expected = "んにょ" },
    { input = "kanji", expected = "かんじ" },
    { input = "kannji", expected = "かんじ" },
    { input = "kannnji", expected = "かんんじ" },
    { input = "kana", expected = "かな" },
    { input = "kanna", expected = "かんな" },
    { input = "kannna", expected = "かんな" },
    { input = "kannnna", expected = "かんんあ" },
    { input = "konitiha", expected = "こにちは" },
    { input = "konnnitiha", expected = "こんにちは" },
    { input = "kanda", expected = "かんだ" },
    { input = "kannda", expected = "かんだ" },
    { input = "kannnda", expected = "かんんだ" },
    { input = "kannnen", expected = "かんねn" },
    { input = "kannnnen", expected = "かんんえn" },
    { input = "nya", expected = "にゃ" },
    { input = "nwa", expected = "ぬぁ" },
    { input = "nnwa", expected = "んわ" },
}

for _, case in ipairs(typing_cases) do
    local actual = type_text(case.input)
    assert(actual == case.expected, case.input .. ": expected " .. case.expected .. ", got " .. actual)
end

-- SPEC: the reading used when Space converts.
local conversion_cases = {
    { input = "kan", expected = "かん" },
    { input = "kanji", expected = "かんじ" },
    { input = "kannji", expected = "かんじ" },
    { input = "kannnji", expected = "かんじ" },
    { input = "kana", expected = "かな" },
    { input = "nya", expected = "にゃ" },
    { input = "kanna", expected = "かんな" },
    { input = "kannna", expected = "かんな" },
    { input = "kannnna", expected = "かんな" },
    { input = "konnnitiha", expected = "こんにちは" },
    { input = "kanda", expected = "かんだ" },
    { input = "kannda", expected = "かんだ" },
    { input = "kannnda", expected = "かんだ" },
    { input = "kannnen", expected = "かんねん" },
    { input = "kannnnen", expected = "かんねん" },
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

env = new_environment()
processor.init(env)
env.context:push_input("かn")
env.context.caret_pos = #"か"
press(env, "j")
assert(env.context.input == "かjn", "middle-of-input typing must not delete text before the caret")

-- SPEC: a vowel right after the nn pair rebinds the fresh ん as ん+n
-- (kanna -> かんな), but only while no other key intervened.
env = new_environment()
processor.init(env)
press(env, "n")
press(env, "n")
assert(env.context.input == "ん", "nn must become ん on the second keypress")
press(env, "a")
assert(env.context.input == "んな", "a right after the nn pair should rebind to んな")

-- Backspace between the pair and the vowel drops the rebind (ん stays).
env = new_environment()
processor.init(env)
press(env, "n")
press(env, "n")
press_key(env, kBackSpace)
press(env, "a")
assert(env.context.input == "んあ", "a vowel after Backspace must not rebind the ん")

-- A lone ん that did not come from an nn pair does not rebind either.
env = new_environment()
processor.init(env)
env.context:push_input("ん")
press(env, "a")
assert(env.context.input == "んあ", "a vowel after a foreign ん must not rebind")

print("Kagiroi n kana-speller transition tests passed")
