local kAccepted = 1
local kNoop = 2
local romaji_to_kana = {
    nn = "ん",
    ko = "こ",
    ka = "か",
    na = "な",
    ni = "に",
    ji = "じ",
    chi = "ち",
    ha = "は",
    nya = "にゃ",
}

local base = {}
function base.init(env)
    env.alphabet = "abcdefghijklmnopqrstuvwxyz-;"
    env.prefix = ""
end
function base.fini() end
function base.func(key_event, env)
    if key_event.keycode == 0x20 then
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
        self.input = self.input:sub(1, self.caret_pos) .. self.input:sub(self.caret_pos + length + 1)
    end
    function context:push_input(text)
        self.input = self.input:sub(1, self.caret_pos) .. text .. self.input:sub(self.caret_pos + 1)
        self.caret_pos = self.caret_pos + #text
    end
    context.composition = composition

    return {
        engine = { context = context },
        context = context,
        alphabet = "abcdefghijklmnopqrstuvwxyz-;",
        prefix = "",
    }
end

local function press(env, character)
    local key_event = {
        keycode = character:byte(),
        release = function() return false end,
        ctrl = function() return false end,
        alt = function() return false end,
        super = function() return false end,
    }
    local result = processor.func(key_event, env)
    if result == kNoop and character ~= " " then
        env.context:push_input(character)
    end
end

local function type_text(text)
    local env = new_environment()
    processor.init(env)
    for character in text:gmatch(".") do
        press(env, character)
    end
    return env.context.input
end

local cases = {
    { input = "kanji", expected = "かんじ" },
    { input = "kannji", expected = "かんじ" },
    { input = "kannnji", expected = "かんじ" },
    { input = "konnichiha", expected = "こんにちは" },
    { input = "konnnichiha", expected = "こんにちは" },
    { input = "kana", expected = "かな" },
    { input = "kanna", expected = "かんな" },
    { input = "nya", expected = "にゃ" },
}

for _, case in ipairs(cases) do
    local actual = type_text(case.input)
    assert(actual == case.expected, case.input .. ": expected " .. case.expected .. ", got " .. actual)
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

print("Kagiroi n kana-speller transition tests passed")
