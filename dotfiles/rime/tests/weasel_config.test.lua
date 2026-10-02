-- Frontend display contract values for Weasel
-- (dotfiles/rime/SPEC.md): the candidate list pages with the mouse wheel,
-- and the input-state notifications and the tray icon stay hidden. The
-- values are asserted statically: the librime harness cannot observe the
-- frontend.
local path = arg[1]
assert(path, "usage: lua5.4 tests/weasel_config.test.lua weasel.custom.yaml")

local values = {}
for line in io.lines(path) do
    local key, value = line:match('^%s*"?([^":%s]+)"?%s*:%s*([^%s#]+)')
    if key and key ~= "patch" then
        values[key] = value
    end
end

local function assert_value(key, expected)
    local actual = values[key]
    assert(actual ~= nil, key .. " must be set in " .. path)
    assert(actual == expected,
        key .. " must be " .. expected .. ", got " .. tostring(actual))
end

assert_value("style/paging_on_scroll", "true")
assert_value("style/preedit_type", "preview")
assert_value("show_notifications", "false")
assert_value("style/display_tray_icon", "false")

print("Rime weasel config tests passed")
