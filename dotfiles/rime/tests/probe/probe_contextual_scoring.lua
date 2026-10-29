-- Probe 2: contextual clause candidate enumeration and scoring.
--
-- Shows on synthetic data (real dictionary rows + real matrix values where
-- available):
--   1. best_n drops same-text different-id candidates before any context
--      could pick the fitting id, so re-sorting its output is not enough.
--   2. Enumerating (text, id) pairs from the lattice keeps them; scoring with
--      own cost (assembly cost minus the four end terms) plus real neighbor
--      connections flips the ranking exactly where context demands it.
--   3. Replacing the end terms of each clause with the true neighbor terms
--      reproduces the full-path cost exactly (no double counting).
--   4. Learned userdict entries (with and without ids) join the enumeration;
--      id-less entries cannot be scored and stay unscored.
--
-- Run: lua5.4 probe_contextual_scoring.lua

local probe_dir = arg[0] and arg[0]:match("^(.*)/") or "."
package.path = probe_dir .. "/fixed/?.lua;" .. probe_dir .. "/?.lua;" .. package.path

local synth = require("viterbi_synth_env")
synth.install_globals()
local viterbi_module = require("kagiroi/kagiroi_viterbi")

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
    { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
}

local function best_n_list(v)
    local iter = v:best_n()
    local list = {}
    for assem in iter do
        list[#list + 1] = assem
    end
    return list
end

local function end_terms(v, left_id, right_id)
    return v:_get_matrix_cost(0, left_id) + v:_get_prefix_penalty(left_id)
        + v:_get_matrix_cost(right_id, 0) + v:_get_suffix_penalty(right_id)
end

local function own_cost(v, assem)
    return assem.cost - end_terms(v, assem.left_id, assem.right_id)
end

local function single_node_covers(v, reading)
    local covers = {}
    local length = utf8.len(reading)
    for _, node in ipairs(v.lattice[length] or {}) do
        if node.start == 1 and node.type == "lex" then
            covers[#covers + 1] = node
        end
    end
    table.sort(covers, function(a, b) return a.wcost < b.wcost end)
    return covers
end

local function contextual_score(v, own, left_id, right_id, at_start, at_end, prev_right_id, next_left_id)
    local left_term = at_start
        and (v:_get_matrix_cost(0, left_id) + v:_get_prefix_penalty(left_id))
        or v:_get_matrix_cost(prev_right_id, left_id)
    local right_term = at_end
        and (v:_get_matrix_cost(right_id, 0) + v:_get_suffix_penalty(right_id))
        or v:_get_matrix_cost(right_id, next_left_id)
    return own + left_term + right_term
end

print("== 1. best_n dedups same-text candidates; context cannot recover the dropped id")
do
    local env = synth.new_env(real_dict, nil, real_matrix)
    local v = viterbi_module.new(env)
    v:analyze("から")
    local list = best_n_list(v)
    local rows = {}
    for _, assem in ipairs(list) do
        rows[#rows + 1] = string.format("%s(%d,%d,%.0f)", assem.candidate, assem.left_id, assem.right_id, assem.cost)
    end
    print("  best_n(から): " .. table.concat(rows, ", "))
    local texts = {}
    for _, assem in ipairs(list) do texts[assem.candidate] = true end
    check(texts["から"] and texts["空"], "best_n lists the two texts")
    check(list[1].left_id == 368, "the text から appears only with its best-isolated id (368)")
    local seen_text_count = 0
    for _, assem in ipairs(list) do
        if assem.candidate == "から" then seen_text_count = seen_text_count + 1 end
    end
    check(seen_text_count == 1, "the 330-reading of から is absent from best_n output")
end

print("== 2. lattice enumeration keeps (text, id) pairs; contextual scoring flips the order")
do
    -- The same clause reading から between fixed 千葉 (right id 1926) and
    -- 東京 (left id 1927), but with a matrix that punishes the case particle
    -- (368) and rewards the conjunctive particle (330): only the enumeration
    -- with ids can express the winner.
    local flip_matrix = {}
    for key, cost in pairs(real_matrix) do flip_matrix[key] = cost end
    flip_matrix["1926 368"] = 50000
    flip_matrix["368 1927"] = 50000
    flip_matrix["1926 330"] = 10
    flip_matrix["330 1927"] = 10
    flip_matrix["1926 1851"] = 20000
    flip_matrix["1851 1927"] = 20000

    local env = synth.new_env(real_dict, nil, flip_matrix)
    local v = viterbi_module.new(env)
    v:analyze("から")

    local scored = {}
    for _, node in ipairs(single_node_covers(v, "から")) do
        scored[#scored + 1] = {
            text = node.candidate,
            left_id = node.left_id,
            right_id = node.right_id,
            own = node.wcost,
            score = contextual_score(v, node.wcost, node.left_id, node.right_id, false, false, 1926, 1927),
        }
    end
    table.sort(scored, function(a, b) return a.score < b.score end)
    local rows = {}
    for _, item in ipairs(scored) do
        rows[#rows + 1] = string.format("%s(%d,%d) own=%.0f score=%.0f",
            item.text, item.left_id, item.right_id, item.own, item.score)
    end
    print("  contextual enumeration: " .. table.concat(rows, ", "))
    check(scored[1].text == "から" and scored[1].left_id == 330,
        "the 330 variant of から leads when the neighbors reward it")
    check(#scored == 3, "all three (text, id) pairs survive enumeration (から368, から330, 空1851)")

    local resorted = {}
    for _, assem in ipairs(best_n_list(v)) do
        resorted[#resorted + 1] = {
            text = assem.candidate,
            left_id = assem.left_id,
            score = contextual_score(v, own_cost(v, assem), assem.left_id, assem.right_id, false, false, 1926, 1927),
        }
    end
    table.sort(resorted, function(a, b) return a.score < b.score end)
    local resort_rows = {}
    for _, item in ipairs(resorted) do
        resort_rows[#resort_rows + 1] = string.format("%s(%d) score=%.0f", item.text, item.left_id, item.score)
        break
    end
    print("  re-sorting best_n output leads with: " .. resort_rows[1])
    check(not (resorted[1].text == "から" and resorted[1].left_id == 330),
        "re-sorting best_n output cannot produce the 330 winner (dropped before scoring)")
end

print("== 3. own + true neighbor terms reproduce the full-path cost exactly")
do
    local env = synth.new_env(real_dict, nil, real_matrix)
    local v = viterbi_module.new(env)
    local reading = "ちばからとうきょう"
    v:analyze(reading)
    local full_cost = v.eos.cost

    local clause_readings = { "ちばから", "とうきょう" }
    local owns, ids = {}, {}
    for index, clause_reading in ipairs(clause_readings) do
        local clause_env = synth.new_env(real_dict, nil, real_matrix)
        local clause_v = viterbi_module.new(clause_env)
        clause_v:analyze(clause_reading)
        local first = clause_v:best_n()()
        check(first ~= nil and first.surface == clause_reading,
            "isolated best_n returns a full-cover assembly for clause " .. index)
        owns[index] = own_cost(clause_v, first)
        ids[index] = { left_id = first.left_id, right_id = first.right_id }
    end

    -- Each interior boundary is assigned once (between the two clauses) for
    -- the cost identity; ranking may also count it inside both neighbors'
    -- scores, which is consistent within each list.
    local start_terms = v:_get_matrix_cost(0, ids[1].left_id) + v:_get_prefix_penalty(ids[1].left_id)
    local interior_conn = v:_get_matrix_cost(ids[1].right_id, ids[2].left_id)
    local end_terms_value = v:_get_matrix_cost(ids[2].right_id, 0) + v:_get_suffix_penalty(ids[2].right_id)
    local reconstructed = start_terms + owns[1] + interior_conn + owns[2] + end_terms_value
    print(string.format("  full eos cost=%.0f, reconstructed=%.0f", full_cost, reconstructed))
    check(reconstructed == full_cost,
        "own plus true neighbor terms equals the full-path cost (each boundary term once)")

    local naive = owns[1] + end_terms(v, ids[1].left_id, ids[1].right_id)
        + owns[2] + end_terms(v, ids[2].left_id, ids[2].right_id)
    print(string.format("  keeping both clauses' isolated end terms=%.0f", naive))
    check(naive ~= full_cost,
        "naive per-clause isolated scoring does not equal the full-path cost (end terms leak into the middle boundary)")
end

print("== 4. learned userdict entries join the enumeration; id-less ones stay unscored")
do
    local userdict = {
        { surface = "から", candidate = "殻", left_id = 1851, right_id = 1851, commit_count = 20 },
        { surface = "から", candidate = "カラ", commit_count = 5 },
    }
    local env = synth.new_env(real_dict, userdict, real_matrix)
    local v = viterbi_module.new(env)
    v:analyze("から")
    local rows = {}
    local unscored = {}
    for _, node in ipairs(single_node_covers(v, "から")) do
        if node.left_id >= 0 then
            rows[#rows + 1] = string.format("%s(%d,%d) own=%.0f", node.candidate, node.left_id, node.right_id, node.wcost)
        else
            unscored[#unscored + 1] = node.candidate
        end
    end
    print("  scored covers: " .. table.concat(rows, ", "))
    print("  unscored covers (no ids): " .. table.concat(unscored, ", "))
    local has_kara_shell = false
    for _, row in ipairs(rows) do has_kara_shell = has_kara_shell or row:find("殻", 1, true) ~= nil end
    check(has_kara_shell, "the learned id-carrying entry 殻 appears as a scored cover")
    check(#unscored == 1 and unscored[1] == "カラ",
        "the id-less learned entry appears as an unscored cover")
end

print(string.format("probe2: %d checks, %d failures", checks, failures))
os.exit(failures == 0 and 0 or 1)
