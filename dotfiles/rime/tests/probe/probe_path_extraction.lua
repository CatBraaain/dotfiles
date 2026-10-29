-- Probe 1: extract the best full-sentence path (real node list with reading
-- ranges) from the upstream viterbi at the fixed commit, via two maintenance
-- approaches, and compare the clause mapping against the current
-- bunsetsu.split (best_n_prefix walk) including a >20 char reading.
--
-- Run: lua5.4 probe_path_extraction.lua

local probe_dir = arg[0] and arg[0]:match("^(.*)/") or "."
package.path = probe_dir .. "/fixed/?.lua;" .. probe_dir .. "/?.lua;" .. package.path

local synth = require("viterbi_synth_env")
synth.install_globals()
local viterbi_module = require("kagiroi/kagiroi_viterbi")
local segmenter = require("kagiroi/segmenter")

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

-- Reads the lattice internals only: eos/pre_index_*/lattice are upstream
-- fields with no public-API guarantee.
local function best_path_adapter(v)
    local nodes = {}
    local cur = v.eos
    while cur and cur.type ~= "bos" do
        nodes[#nodes + 1] = cur
        local column = v.lattice[cur.pre_index_col]
        cur = column and column[cur.pre_index_row] or nil
    end
    if not cur then return nil end
    local path = {}
    for i = #nodes, 2, -1 do path[#path + 1] = nodes[i] end
    return path
end

local function path_surface(path)
    local parts = {}
    for _, node in ipairs(path) do parts[#parts + 1] = node.surface end
    return table.concat(parts)
end

local function path_candidate(path)
    local parts = {}
    for _, node in ipairs(path) do parts[#parts + 1] = node.candidate end
    return table.concat(parts)
end

local function path_cost(v, path)
    local total = v:_get_matrix_cost(0, path[1].left_id) + v:_get_prefix_penalty(path[1].left_id)
    for i, node in ipairs(path) do
        total = total + node.wcost
        local next_node = path[i + 1]
        if next_node then
            total = total + v:_get_matrix_cost(node.right_id, next_node.left_id)
        else
            total = total + v:_get_matrix_cost(node.right_id, 0)
                + v:_get_suffix_penalty(node.right_id)
        end
    end
    return total
end

local function clauses_from_path(path)
    local clauses, current = {}, {}
    for i, node in ipairs(path) do
        current[#current + 1] = node
        local next_node = path[i + 1]
        if not next_node or segmenter.is_boundary_internal(node.right_id, next_node.left_id) then
            clauses[#clauses + 1] = current
            current = {}
        end
    end
    if #current > 0 then clauses[#clauses + 1] = current end
    return clauses
end

local function describe_clauses(clauses)
    local parts = {}
    for _, clause in ipairs(clauses) do
        parts[#parts + 1] = path_surface(clause) .. "=>" .. path_candidate(clause)
    end
    return table.concat(parts, " | ")
end

-- The current bunsetsu.split: repeatedly analyze the remaining reading and
-- take the first best_n_prefix surface as the clause reading.
local function split_clauses(reading, v)
    local clauses = {}
    local remaining = reading
    while remaining ~= "" do
        v:analyze(remaining)
        local lex = v:best_n_prefix()()
        local prefix = lex and lex.surface ~= "" and lex.surface or remaining
        clauses[#clauses + 1] = prefix
        remaining = remaining:sub(#prefix + 1)
    end
    return clauses
end

local real_matrix = {
    ["0 1926"] = 3904, ["-10 1926"] = 6,
    ["0 368"] = 2829, ["-10 368"] = 1559,
    ["0 1851"] = 1066, ["-10 1851"] = 26,
    ["0 330"] = 3485, ["-10 330"] = 2510,
    ["0 1927"] = 4356, ["-10 1927"] = 6,
    ["1927 0"] = 0, ["1927 -20"] = 313,
    ["368 0"] = 0, ["368 -20"] = 52,
    ["1851 0"] = 0, ["1851 -20"] = 463,
    ["330 0"] = 0, ["330 -20"] = 248,
    ["1926 368"] = 2180, ["368 1927"] = 3755,
    ["1926 1851"] = 648, ["1851 1927"] = 4768,
    ["1926 330"] = 12422, ["330 1927"] = 4795,
    ["368 368"] = 4590, ["1851 1851"] = 1189,
    ["1926 1926"] = 2000, ["1927 1927"] = 2000,
}

local real_dict = {
    { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
    { surface = "とうきょう", candidate = "東京", left_id = 1927, right_id = 1927, cost = 0 },
    { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
    { surface = "から", candidate = "空", left_id = 1851, right_id = 1851, cost = 5511 },
    { surface = "から", candidate = "から", left_id = 330, right_id = 330, cost = 4000 },
    -- best_n_prefix skips its smart enumeration unless some node ends at
    -- column 1 (upstream _weave_dummy_iter), so single-mora rows stand in for
    -- the real dictionary's single-kana entries.
    { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
}

print("== segmenter boundary facts (real generated segmenter, fixed commit)")
for _, pair in ipairs({ { 1926, 368 }, { 368, 1927 }, { 1851, 1851 }, { 1926, 1851 }, { 368, 368 }, { 1926, 330 }, { 330, 1927 } }) do
    print(string.format("  is_boundary_internal(%d, %d) = %s", pair[1], pair[2],
        tostring(segmenter.is_boundary_internal(pair[1], pair[2]))))
end

print("== realistic short reading: ちばからとうきょう (real dict rows + real matrix values)")
do
    local env = synth.new_env(real_dict, nil, real_matrix)
    local v = viterbi_module.new(env)
    local reading = "ちばからとうきょう"
    v:analyze(reading)
    local best = v:best_n()()
    check(best ~= nil, "best_n returns a full-sentence assembly")
    local adapter_path = best_path_adapter(v)
    check(adapter_path ~= nil, "minimal adapter extracts a path")
    check(path_surface(adapter_path) == reading, "adapter path covers the whole reading")
    check(path_candidate(adapter_path) == best.candidate, "adapter path candidate equals best_n candidate")
    check(path_cost(v, adapter_path) == best.cost,
        "adapter path cost recomputation equals best_n cost (no missing/duplicated term)")
    local clauses = clauses_from_path(adapter_path)
    print("  full-path clause mapping: " .. describe_clauses(clauses))
    local current = split_clauses(reading, v)
    print("  current split readings:   " .. table.concat(current, " | "))
    local mapped_readings = {}
    for _, clause in ipairs(clauses) do mapped_readings[#mapped_readings + 1] = path_surface(clause) end
    check(table.concat(mapped_readings, "|") == table.concat(current, "|"),
        "full-path mapping agrees with the current split on this short reading")
end

print("== >20 char reading: reverse detour truncates at 20, full path does not")
do
    -- Full-sentence best: A1(1-5) -> B1(6-25, crosses col 20, cheap).
    -- Truncated prefix search: B1 is invisible (rcost huge), so the cheapest
    -- reachable continuation runs A2(1-6) -> C1(7-15) -> E1(16-20) -> fake EOS,
    -- and the first split clause comes from the A2 path instead.
    local long_dict = {
        { surface = "あ", candidate = "阿", left_id = 1851, right_id = 1851, cost = 6000 },
        { surface = "あいうえお", candidate = "青井上男", left_id = 1851, right_id = 1851, cost = 1000 },
        { surface = "あいうえおか", candidate = "愛植上岡", left_id = 1926, right_id = 1926, cost = 2000 },
        { surface = "かきくけこさしすせそたちつてとなにぬねの", candidate = "夏樹家子", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "きくけこさしすせそ", candidate = "菊池勢", left_id = 1851, right_id = 1851, cost = 3000 },
        { surface = "かきくけこ", candidate = "柿久毛子", left_id = 1851, right_id = 1851, cost = 90000000 },
        { surface = "たちつてと", candidate = "田茅津十斗", left_id = 1851, right_id = 1851, cost = 5000 },
        { surface = "たちつてとなにぬねの", candidate = "田茅津十斗名仁猫", left_id = 1851, right_id = 1851, cost = 90000000 },
    }
    local env = synth.new_env(long_dict, nil, real_matrix)
    local v = viterbi_module.new(env)
    local reading = "あいうえおかきくけこさしすせそたちつてとなにぬねの"
    check(utf8.len(reading) == 25, "the long reading has 25 characters")
    v:analyze(reading)
    local adapter_path = best_path_adapter(v)
    print("  full best path: " .. path_candidate(adapter_path) .. " [" .. path_surface(adapter_path) .. "]")
    local clauses = clauses_from_path(adapter_path)
    print("  full-path clause mapping: " .. describe_clauses(clauses))
    local current = split_clauses(reading, v)
    print("  current split readings:   " .. table.concat(current, " | "))
    check(current[1] ~= path_surface(clauses[1]),
        "the current split disagrees with the full-path mapping beyond 20 characters")
end

print("== explicit extension: upstream copy with a public best_path() API")
do
    package.loaded["kagiroi/kagiroi_viterbi"] = nil
    package.loaded["kagiroi/kagiroi"] = nil
    package.loaded["kagiroi/segmenter"] = nil
    package.loaded["kagiroi/priority_queue"] = nil
    package.loaded["kagiroi/lru"] = nil
    local saved_path = package.path
    package.path = probe_dir .. "/fixed_ext/?.lua;" .. package.path
    local ext_module = require("kagiroi/kagiroi_viterbi")
    package.path = saved_path
    local env = synth.new_env(real_dict, nil, real_matrix)
    local v = ext_module.new(env)
    local reading = "ちばからとうきょう"
    v:analyze(reading)
    local best = v:best_n()()
    local result = v:best_path()
    check(result ~= nil and result.cost == best.cost and path_surface(result.nodes) == reading
        and path_candidate(result.nodes) == best.candidate,
        "extension best_path() equals the best_n assembly (surface, candidate, cost)")
    local long_env = synth.new_env({
        { surface = "あ", candidate = "阿", left_id = 1851, right_id = 1851, cost = 6000 },
        { surface = "あいうえお", candidate = "青井上男", left_id = 1851, right_id = 1851, cost = 1000 },
        { surface = "あいうえおか", candidate = "愛植上岡", left_id = 1926, right_id = 1926, cost = 2000 },
        { surface = "かきくけこさしすせそたちつてとなにぬねの", candidate = "夏樹家子", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "きくけこさしすせそ", candidate = "菊池勢", left_id = 1851, right_id = 1851, cost = 3000 },
        { surface = "かきくけこ", candidate = "柿久毛子", left_id = 1851, right_id = 1851, cost = 90000000 },
        { surface = "たちつてと", candidate = "田茅津十斗", left_id = 1851, right_id = 1851, cost = 5000 },
        { surface = "たちつてとなにぬねの", candidate = "田茅津十斗名仁猫", left_id = 1851, right_id = 1851, cost = 90000000 },
    }, nil, real_matrix)
    local lv = ext_module.new(long_env)
    lv:analyze("あいうえおかきくけこさしすせそたちつてとなにぬねの")
    local long_result = lv:best_path()
    check(long_result ~= nil and utf8.len(path_surface(long_result.nodes)) == 25,
        "extension extracts the >20 char full path")
end

print(string.format("probe1: %d checks, %d failures", checks, failures))
os.exit(failures == 0 and 0 or 1)
