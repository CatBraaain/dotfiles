local yaml_path = arg[1]
local gate_path = arg[2]
local text_path = arg[3]
assert(yaml_path and gate_path and text_path,
    "usage: lua5.4 tests/kagiroi_config.test.lua kagiroi.custom.yaml "
    .. "lua/kagiroi/candidate_gate.lua <zenkaku_text.lua>")

local page_size
local label_count = 0
local alphabet
local in_labels = false
for line in io.lines(yaml_path) do
    local size = line:match('^%s*"menu/page_size"%s*:%s*(%d+)')
    if size then
        assert(page_size == nil, "menu/page_size must be assigned exactly once")
        page_size = tonumber(size)
    end
    local symbols = line:match('^%s*"speller/alphabet/%+"%s*:%s*"(.*)"%s*$')
    if symbols then
        assert(alphabet == nil, "speller/alphabet/+ must be assigned exactly once")
        alphabet = symbols
    end
    if line:match('^%s*"menu/alternative_select_labels"%s*:') then
        in_labels = true
    elseif in_labels then
        local label = line:match('^%s*%-%s*"([^"]+)"%s*$')
        if label then
            label_count = label_count + 1
        else
            in_labels = false
        end
    end
end
assert(page_size == 30,
    "menu/page_size must be 30, got " .. tostring(page_size))
assert(label_count == 30,
    "menu/alternative_select_labels must list 30 labels, got " .. label_count)
assert(alphabet, "speller/alphabet/+ must be set in " .. yaml_path)

local expanded_width, collapsed_width, collapsed_limit
for line in io.lines(gate_path) do
    local wide, narrow = line:match("expanded and (%d+) or (%d+)")
    if wide then
        assert(expanded_width == nil,
            "candidate page width must be assigned exactly once")
        expanded_width = tonumber(wide)
        collapsed_width = tonumber(narrow)
    end
    local limit = line:match("count == (%d+)")
    if limit then
        assert(collapsed_limit == nil,
            "collapsed candidate limit must be assigned exactly once")
        collapsed_limit = tonumber(limit)
    end
end
assert(expanded_width == page_size,
    "expanded candidate width must equal menu/page_size, got "
    .. tostring(expanded_width))
assert(collapsed_width == 10,
    "collapsed candidate width must be 10, got " .. tostring(collapsed_width))
assert(collapsed_limit == collapsed_width,
    "collapsed candidate limit must equal the collapsed width, got "
    .. tostring(collapsed_limit))

local keypad = {}
for line in io.lines(text_path) do
    local keycode = line:match('^%s*%[(0x%x+)%]%s*=%s*true%s*,?%s*$')
    if keycode then
        keypad[keycode] = true
    end
end
assert(next(keypad), "no keypad_keys entries found in " .. text_path)

local appended_count = 0
for line in io.lines(text_path) do
    local keycode, text = line:match('^%s*%[(0x%x+)%]%s*=%s*"([^"]*)"')
    if keycode and not keypad[keycode] then
        appended_count = appended_count + 1
        for character in text:gmatch(utf8.charpattern) do
            assert(alphabet:find(character, 1, true),
                "speller/alphabet/+ must accept the appended text " .. text
                .. " including " .. character)
        end
    end
end
assert(appended_count > 0, "no appended key texts found in " .. text_path)

print("Rime kagiroi config tests passed")
