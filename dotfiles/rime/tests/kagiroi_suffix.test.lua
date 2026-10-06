local kAccepted = 1
local kNoop = 2
local spellings = { a = "あ", i = "い", sa = "さ", ha = "は", hi = "ひ", sha = "しゃ" }
local base = {}

function base.init(env)
    env.alphabet = "abcdefghijklmnopqrstuvwxyz-;"
    env.prefix = ""
    env.roma2hira_xlator = true
end

function base.query_roma2hira_xlator(spelling)
    if spellings[spelling] then
        return { text = spellings[spelling], _end = #spelling }
    end
    if spelling == "saq" then
        return { text = "さ", _end = 2 }
    end
    return nil
end

function base.func(key_event, env)
    local context = env.engine.context
    local suffix = context.input:match("([a-z%-;]*)$") or ""
    local spelling = suffix .. string.char(key_event.keycode)
    local candidate = base.query_roma2hira_xlator(spelling)
    if not candidate or candidate._end ~= #spelling then
        return kNoop
    end
    context:pop_input(#suffix)
    context:push_input(candidate.text)
    return kAccepted
end

package.preload["kagiroi/kagiroi_kana_speller"] = function()
    return base
end

package.preload["kagiroi/zenkaku_rules"] = function() return dofile(arg[2]) end

local processor = dofile(arg[1])

local function new_environment()
    local context = { input = "", caret_pos = 0 }
    function context:get_option() return false end
    function context:pop_input(length)
        self.input = self.input:sub(1, self.caret_pos - length) .. self.input:sub(self.caret_pos + 1)
        self.caret_pos = self.caret_pos - length
    end
    function context:push_input(text)
        self.input = self.input:sub(1, self.caret_pos) .. text .. self.input:sub(self.caret_pos + 1)
        self.caret_pos = self.caret_pos + #text
    end
    context.composition = {
        back = function()
            if context.input == "" then return nil end
            return {
                start = 0,
                _end = #context.input,
                has_tag = function(_, tag) return tag == "kagiroi" end,
            }
        end,
    }
    local env = { engine = { context = context } }
    processor.init(env)
    return env
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
    if result == kNoop then
        env.engine.context:push_input(character)
    end
    return result
end

for _, case in ipairs({
    { "fdsa", "fdさ" },
    { "shi", "sひ" },
    { "sha", "しゃ" },
    { "fdsha", "fdしゃ" },
    { "q", "q" },
    { "xsaq", "xさq" },
}) do
    local env = new_environment()
    for character in case[1]:gmatch(".") do
        press(env, character)
    end
    local actual = env.engine.context.input
    assert(actual == case[2], case[1] .. ": expected " .. case[2] .. ", got " .. actual)
end

local env = new_environment()
env.engine.context:push_input("fdsh")
env.engine.context.caret_pos = 2
press(env, "a")
assert(env.engine.context.input == "fdash", "typing in the middle must not consume the suffix")

env = new_environment()
env.engine.context:push_input("fsa")
press(env, "q")
assert(env.engine.context.input == "fsaq", "a partially matched suffix must remain raw")

print("Kagiroi suffix conversion tests passed")
