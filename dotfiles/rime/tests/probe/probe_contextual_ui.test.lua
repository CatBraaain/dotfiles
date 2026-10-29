-- Probe 3: contextual clause mechanics on a mocked engine. Drives the
-- prototype bunsetsu.lua directly and checks, with a controlled synthetic
-- viterbi (lattice + ids + matrix), that:
--   3. window_start/highlight follow the reordered list across the page
--      boundary (paging contract);
--   4. a boundary change regenerates exactly the two adjacent clauses and
--      keeps every other clause's selection;
--   5. learning stores entries with the generic noun ids (1851 1851)
--      including the joined whole-reading entry.
--
-- Run: lua5.4 probe_contextual_ui.test.lua ../../lua/kagiroi/bunsetsu.lua

local bunsetsu_path = arg[1]
package.path = string.match(bunsetsu_path, "^(.*)/kagiroi/") .. "/?.lua;" .. package.path

_G.yield = coroutine.yield
_G.Translation = function(func)
    return { iter = function() return coroutine.wrap(func) end }
end
_G.Set = function(tags) return tags end
_G.Segment = function(start, finish)
    return { start = start, _end = finish, has_tag = function() return true end }
end
_G.Candidate = function(kind, start, finish, text, comment)
    local candidate = { type = kind, start = start, _end = finish, text = text, comment = comment }
    function candidate:get_genuine() return self end
    function candidate:to_phrase() return self.phrase and { entry = self.phrase } or nil end
    return candidate
end
_G.ShadowCandidate = function(candidate, kind, text, comment)
    local shadow = { type = kind, text = text, comment = comment, start = candidate.start, _end = candidate._end }
    function shadow:get_genuine() return candidate end
    function shadow:to_phrase() return candidate:to_phrase() end
    return shadow
end
_G.DictEntry = function(copy)
    return copy and { text = copy.text, custom_code = copy.custom_code }
        or { text = "", custom_code = "" }
end
_G.Phrase = function(mem, tag, start, finish, entry)
    return {
        toCandidate = function()
            local candidate = Candidate("kagiroi", start, finish, entry.text, "")
            candidate.phrase = entry
            return candidate
        end,
    }
end
_G.Opencc = function() return { convert = function(_, text) return text end } end

local readings = {
    ["あかとりさかな"] = {
        { text = "赤とり魚", phrase = { text = "赤とり魚|100 400", custom_code = "あかとりさかな " } },
    },
    ["あか"] = {
        { text = "赤", phrase = { text = "赤|100 100", custom_code = "あか " } },
        { text = "朱", phrase = { text = "朱|100 100", custom_code = "あか " } },
        { text = "v1" }, { text = "v2" }, { text = "v3" }, { text = "v4" }, { text = "v5" },
        { text = "v6" }, { text = "v7" }, { text = "v8" }, { text = "v9" }, { text = "v10" },
    },
    ["とり"] = {
        { text = "鳥", phrase = { text = "鳥|200 200", custom_code = "とり " } },
        { text = "取り", phrase = { text = "取り|210 210", custom_code = "とり " } },
    },
    ["さかな"] = {
        { text = "魚", phrase = { text = "魚|400 400", custom_code = "さかな " } },
        { text = "肴", phrase = { text = "肴|410 410", custom_code = "さかな " } },
    },
    ["とりさ"] = {
        { text = "鳥舎", phrase = { text = "鳥舎|200 400", custom_code = "とりさ " } },
    },
    ["かな"] = {
        { text = "金", phrase = { text = "金|400 400", custom_code = "かな " } },
    },
}

local assems = {
    ["あか"] = {
        { surface = "あか", candidate = "赤", cost = 2510, left_id = 100, right_id = 100 },
        { surface = "あか", candidate = "朱", cost = 2210, left_id = 100, right_id = 100 },
    },
    ["とり"] = {
        { surface = "とり", candidate = "鳥", cost = 645, left_id = 200, right_id = 200 },
        { surface = "とり", candidate = "取り", cost = 755, left_id = 210, right_id = 210 },
    },
    ["さかな"] = {
        { surface = "さかな", candidate = "魚", cost = 900, left_id = 400, right_id = 400 },
        { surface = "さかな", candidate = "肴", cost = 1000, left_id = 410, right_id = 410 },
    },
}

local matrix = {
    ["0 100"] = 500, ["-10 100"] = 10, ["100 0"] = 0, ["100 -20"] = 30,
    ["0 300"] = 400, ["-10 300"] = 20, ["300 0"] = 0, ["300 -20"] = 40,
    ["0 200"] = 600, ["-10 200"] = 15, ["200 0"] = 0, ["200 -20"] = 30,
    ["0 210"] = 610, ["-10 210"] = 15, ["210 0"] = 0, ["210 -20"] = 5,
    ["0 400"] = 700, ["-10 400"] = 25, ["400 0"] = 0, ["400 -20"] = 50,
    ["0 410"] = 710, ["-10 410"] = 25, ["410 0"] = 0, ["410 -20"] = 50,
    ["100 200"] = 900, ["100 210"] = 50, ["100 400"] = 800,
    ["300 200"] = 100, ["300 210"] = 700, ["300 400"] = 80,
    ["200 400"] = 200, ["210 400"] = 900, ["200 410"] = 800, ["210 410"] = 50,
}

local path_nodes = {
    { candidate = "赤", surface = "あか", left_id = 100, right_id = 100,
        start = 1, _end = 2, wcost = 1000, type = "lex",
        pre_index_col = 0, pre_index_row = 1 },
    { candidate = "鳥", surface = "とり", left_id = 200, right_id = 200,
        start = 3, _end = 4, wcost = 0, type = "lex",
        pre_index_col = 2, pre_index_row = 3 },
    { candidate = "魚", surface = "さかな", left_id = 400, right_id = 400,
        start = 5, _end = 7, wcost = 0, type = "lex",
        pre_index_col = 4, pre_index_row = 1 },
}

local bos = { type = "bos" }
local full_lattice = {
    [0] = { bos },
    [2] = {
        { candidate = "赤", left_id = 100, right_id = 100, start = 1, _end = 2,
            wcost = 1000, type = "lex" },
        { candidate = "赤", left_id = 300, right_id = 300, start = 1, _end = 2,
            wcost = 500, type = "lex" },
        path_nodes[1],
    },
    [4] = { path_nodes[2] },
    [7] = { path_nodes[3] },
}
local lattices = {
    ["あかとりさかな"] = full_lattice,
    ["あか"] = {
        [0] = { bos },
        [2] = {
            { candidate = "赤", left_id = 100, right_id = 100, start = 1, _end = 2,
                wcost = 1000, type = "lex" },
            { candidate = "赤", left_id = 300, right_id = 300, start = 1, _end = 2,
                wcost = 500, type = "lex" },
        },
    },
    ["とり"] = {
        [0] = { bos },
        [2] = {
            { candidate = "鳥", left_id = 200, right_id = 200, start = 1, _end = 2,
                wcost = 0, type = "lex" },
            { candidate = "取り", left_id = 210, right_id = 210, start = 1, _end = 2,
                wcost = 125, type = "lex" },
        },
    },
    ["さかな"] = {
        [0] = { bos },
        [3] = {
            { candidate = "魚", left_id = 400, right_id = 400, start = 1, _end = 3,
                wcost = 125, type = "lex" },
            { candidate = "肴", left_id = 410, right_id = 410, start = 1, _end = 3,
                wcost = 215, type = "lex" },
        },
    },
}

package.preload["kagiroi/segmenter"] = function()
    return { is_boundary_internal = function(right_id, left_id)
        if right_id == 0 or left_id == 0 then return true end
        return matrix[right_id .. " " .. left_id] ~= nil
    end }
end

package.preload["kagiroi/kagiroi_translator"] = function()
    return {
        init = function(env)
            env.tag = "kagiroi"
            env.hira2kata_opencc = function() return Opencc() end
            env.viterbi = {
                analyze = function(self, input)
                    self.reading = input
                    self.lattice = lattices[input] or { [0] = { bos } }
                end,
                best_n = function(self)
                    local list = assems[self.reading] or {}
                    local index = 0
                    return function()
                        index = index + 1
                        return list[index]
                    end
                end,
                best_n_prefix = function(self)
                    local offered = false
                    return function()
                        if offered then return nil end
                        offered = true
                        return { surface = self.reading }
                    end
                end,
                clear = function() end,
                eos = { type = "eos", pre_index_col = 7, pre_index_row = 1 },
                lattice = full_lattice,
                _get_matrix_cost = function(_, right_id, left_id)
                    local cost = matrix[right_id .. " " .. left_id]
                    if cost == nil then return math.huge end
                    return cost
                end,
            }
        end,
        fini = function() end,
        func = function(input, seg, env)
            for _, offered in ipairs(readings[input] or {}) do
                local candidate = Candidate("kagiroi", seg.start, seg._end, offered.text, "")
                candidate.phrase = offered.phrase
                yield(candidate)
            end
        end,
    }
end

local bunsetsu = dofile(bunsetsu_path)

local checks, failures = 0, 0
local function check(condition, description)
    checks = checks + 1
    if condition then
        print("  ok: " .. description)
    else
        failures = failures + 1
        print("  FAIL: " .. description)
    end
end

local function new_environment()
    local segment = { selected_index = 0 }
    local context = { options = {}, properties = {}, commits = {} }
    function context:get_property(name) return self.properties[name] or "" end
    function context:set_property(name, value) self.properties[name] = value end
    context.option_update_notifier = { connect = function() return { disconnect = function() end } end }
    context.composition = { back = function() return segment end }
    function segment:get_candidate_at(index)
        local state = bunsetsu.state(context)
        if state then
            local clause = state.clauses[state.active]
            return clause.candidates[state.window_start + index + 1]
        end
        return nil
    end
    function context:has_menu()
        return self.input ~= "" and not self.options._kagiroi_hide_candidates
            and segment:get_candidate_at(0) ~= nil
    end
    function context:get_option(name) return self.options[name] or false end
    function context:set_option(name, value) self.options[name] = value end
    function context:highlight(index)
        if segment:get_candidate_at(index) then segment.selected_index = index end
    end
    setmetatable(context, {
        __newindex = function(table, key, value)
            if key == "input" then
                rawset(table, "_input", value)
                local state = bunsetsu.state(table)
                if value ~= "" and state then
                    local seg = Segment(state.active_start, state.active_end)
                    local translation = Translation(function()
                        bunsetsu.func(value, seg, table.translator_env)
                    end)
                    local filter_env = { engine = table.translator_env.engine, segment = seg }
                    if bunsetsu.filter.tags_match(seg, filter_env) then
                        for _ in coroutine.wrap(function()
                            bunsetsu.filter.func(translation, filter_env)
                        end) do end
                    end
                end
            else
                rawset(table, key, value)
            end
        end,
        __index = function(table, key)
            if key == "input" then return rawget(table, "_input") or "" end
            return nil
        end,
    })
    context.input = ""
    local userdict_writes = {}
    local env = {
        engine = { context = context },
        mem = { update_userdict = function(_, entry, count, code)
            userdict_writes[#userdict_writes + 1] = { text = entry.text, custom_code = entry.custom_code }
        end },
    }
    env.userdict_writes = userdict_writes
    bunsetsu.init(env)
    context.translator_env = env
    return env, context, segment
end

print("== 1. full-path clause mapping with same-text different-id covers")
local env, context = new_environment()
bunsetsu.start(context, "あかとりさかな")
local state = bunsetsu.state(context)
check(#state.clauses == 3 and state.clauses[1].reading == "あか"
    and state.clauses[2].reading == "とり" and state.clauses[3].reading == "さかな",
    "the full path maps the reading into three clauses")
local display_initial = bunsetsu.display(context)
print("  initial display: " .. display_initial)
check(display_initial == "赤鳥魚",
    "the initial display joins the final contextual firsts")
local clause1 = state.clauses[1]
local aka_texts = {}
for _, choice in ipairs(clause1.unfiltered) do
    aka_texts[#aka_texts + 1] = choice.text .. "(" .. tostring(choice.left_id) .. ")"
end
print("  clause1 unfiltered: " .. table.concat(aka_texts, ", "))
check(clause1.unfiltered[1].text == "赤" and clause1.unfiltered[1].left_id == 300,
    "the same-text 300 variant of 赤 ranks first under the context")
check(clause1.candidates[clause1.selected].text == "赤",
    "the selected display 赤 survives the reorder and the same-text dedup")

local selected_aka = clause1.candidates[clause1.selected]
local selected_tori = state.clauses[2].candidates[state.clauses[2].selected]
local independent_tori_score = 0 + matrix["300 200"] + matrix["200 400"]
local independent_tori_alt_score = 125 + matrix["300 210"] + matrix["210 400"]
check(selected_aka.entry.text == "赤|300 300" and independent_tori_score == 300
    and independent_tori_alt_score == 1725 and independent_tori_score < independent_tori_alt_score,
    "independent costs under the final filtered 赤300 favor 鳥300 over 取り1725")
check(state.clauses[2].candidates[1].text == "鳥" and state.clauses[2].selected == 1
    and selected_tori.text == "鳥" and display_initial == "赤鳥魚",
    "final filtered rank, initial selection and preview use the same current ids")

print("== 2. selection re-ranks the neighbor order but keeps its display")
state.active = 2
context:set_option("_kagiroi_hide_candidates", false)
bunsetsu.render(context)
local clause2 = state.clauses[2]
local tori_before = {}
for _, choice in ipairs(clause2.candidates) do
    tori_before[#tori_before + 1] = choice.text
end
print("  clause2 filtered order: " .. table.concat(tori_before, ", "))
check(#tori_before == 2 and tori_before[1] == "鳥",
    "clause2's menu dedups to one row per text with the contextual winner first")
check(clause2.candidates[clause2.selected].text == "鳥",
    "clause2 selects the final contextual head 鳥")

bunsetsu.select(context, 1)
check(state.clauses[2].candidates[state.clauses[2].selected].text == "取り",
    "selecting 取り in clause2 changes its display")
local clause3_after = {}
for _, choice in ipairs(state.clauses[3].unfiltered) do
    clause3_after[#clause3_after + 1] = choice.text
end
print("  clause3 order after 取り selected: " .. table.concat(clause3_after, ", "))
check(clause3_after[1] == "肴",
    "clause3's order follows the new left neighbor id (210 favors 肴)")
check(state.clauses[3].candidates[state.clauses[3].selected].text == "魚",
    "clause3's selected display 魚 is preserved through the re-rank")
local display_after_select = bunsetsu.display(context)
print("  display after select: " .. display_after_select)
check(display_after_select == "赤取り魚", "the whole display updates only clause2")
print("== 3. window_start and highlight follow the reordered list")
state.active = 1
bunsetsu.render(context)
local selected = state.clauses[1].selected
check(state.window_start == math.floor((selected - 1) / 10) * 10,
    "window_start follows the selected index in the reordered list")
context:get_option("_kagiroi_hide_candidates")
context:set_option("_kagiroi_hide_candidates", false)
for _ = 1, 10 do bunsetsu.select(context, 1) end
bunsetsu.render(context)
check(state.clauses[1].selected > 10 and state.window_start == 10,
    "crossing the tenth candidate moves the window to the second page")

print("== 4. boundary change regenerates two clauses and protects the rest")
local aka_index
for index, choice in ipairs(state.clauses[1].candidates) do
    if choice.text == "赤" then aka_index = index break end
end
state.clauses[1].selected = aka_index
state.active = 2
local display_before_resize = bunsetsu.display(context)
bunsetsu.resize(context, 1)
check(#state.clauses == 3 and state.clauses[1].reading == "あか"
    and state.clauses[2].reading == "とりさ" and state.clauses[3].reading == "かな",
    "the boundary move reshapes exactly the two adjacent clauses")
check(state.clauses[1].candidates[state.clauses[1].selected].text == "赤",
    "clause1 keeps its selected display through the boundary change")
check(bunsetsu.display(context) == "赤鳥舎金", "the display joins the regenerated first candidates")
check(display_before_resize == "赤取り魚" and bunsetsu.display(context) == "赤鳥舎金",
    "only the two adjacent clauses changed their texts")

print("== 5. learning keeps the generic noun id normalization")
bunsetsu.learn(context)
local stored = env.userdict_writes
for _, write in ipairs(stored) do
    print("  learned: " .. write.text .. " <- " .. write.custom_code)
end
local all_normalized = true
for _, write in ipairs(stored) do
    if not string.find(write.text, "|1851 1851$", 1, false) then all_normalized = false end
end
check(all_normalized, "every learned entry carries the 1851 1851 ids")
local joined = false
for _, write in ipairs(stored) do
    if write.custom_code == "あかとりさかな " then joined = true end
end
check(joined, "the joined whole-reading entry is learned")

print(string.format("probe3: %d checks, %d failures", checks, failures))
os.exit(failures == 0 and 0 or 1)
