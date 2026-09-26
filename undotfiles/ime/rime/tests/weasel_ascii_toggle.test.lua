local kAccepted = 1
local kNoop = 2
local processor = dofile(arg[1])
local context = { options = {} }
function context:get_option(name)
    return self.options[name] or false
end
function context:set_option(name, value)
    self.options[name] = value
end
local env = { engine = { context = context } }

local function press(modifiers)
    modifiers = modifiers or {}
    return processor.func({
        keycode = modifiers.keycode or 0xff2a,
        release = function() return modifiers.release or false end,
        shift = function() return modifiers.shift or false end,
        ctrl = function() return modifiers.ctrl or false end,
        alt = function() return modifiers.alt or false end,
        super = function() return modifiers.super or false end,
    }, env)
end

assert(press() == kAccepted and context:get_option("ascii_mode"), "first Zenkaku_Hankaku must enable ascii mode")
assert(press() == kAccepted and not context:get_option("ascii_mode"), "second Zenkaku_Hankaku must restore Japanese mode")
for _, modifiers in ipairs({
    { release = true }, { shift = true }, { ctrl = true }, { alt = true }, { super = true },
    { keycode = string.byte("a") },
}) do
    assert(press(modifiers) == kNoop, "other key events must pass to ascii_composer")
    assert(not context:get_option("ascii_mode"), "other key events must leave ascii mode unchanged")
end

print("Weasel ascii mode toggle tests passed")
