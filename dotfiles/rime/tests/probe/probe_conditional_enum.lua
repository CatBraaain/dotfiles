-- Probe 4: conditional clause candidate enumeration against a brute-force
-- reference. Runs the real upstream viterbi (fixed snapshot, unmodified)
-- with the production bunsetsu.lua prototype on a mocked engine, and
-- checks with synthetic dictionaries (real matrix values where possible):
--   1. an un-analyzed viterbi still enters the full-path branch on the
--      first conversion (analyze-before-supports-check ordering);
--   2. a multi-word clause keeps same-text different-boundary-id routes:
--      the conditional enumeration matches the brute-force reference
--      (text, ids, score order) where best_n dedup loses the route;
--   3. a clause candidate ranked beyond the isolated head is recovered
--      with a route-level score when the context rewards it;
--   4. a boundary change over scorable clauses re-ranks the regenerated
--      pair and keeps every other clause's selected display;
--   5. candidate generation / re-ranking cost and counts on a larger input;
--   8. every candidate text carrying connection ids gets a route-level
--      score over the whole display list, beyond any head rank cap;
--   9. routes without a scorable path keep their original order after the
--      scored routes and are never dropped;
--   10. a boundary change settles both reshaped sides' first choices under
--      each other and keeps an absorbed-away neighbor's selection.
--   11. 60+ displayed stock texts all keep route-level scores, in display
--      order equal to each text's best route, past the old head caps;
--   12. a same-text id-pair route beyond the discovery head is still
--      materialized and can win the text's display position;
--   13. a display row whose ids spell no route keeps no own; the text is
--      scored through a real route instead of the pair-less row;
--   14. a reshaped pair whose joint cost needs five settle rounds still
--      ends with both sides as contextual firsts under each other.
--
-- Run: lua5.4 probe_conditional_enum.lua ../lua/kagiroi/bunsetsu.lua

local probe_dir = arg[0] and arg[0]:match("^(.*)/") or "."
local bunsetsu_path = arg[1]
package.path = probe_dir .. "/fixed/?.lua;" .. probe_dir .. "/?.lua;"
    .. string.match(bunsetsu_path, "^(.*)/kagiroi/") .. "/?.lua;" .. package.path

local synth = require("viterbi_synth_env")
synth.install_globals()
local viterbi_module = require("kagiroi/kagiroi_viterbi")

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

-- Build one mocked engine around a fresh real viterbi on a synthetic
-- dictionary, so every clause operation goes through the actual lattice.
local function new_engine(dictionary, matrix, readings, expand_emoji, boundary)
    local synth_env = synth.new_env(dictionary, nil, matrix)
    local viterbi = viterbi_module.new(synth_env)
    package.loaded["kagiroi/segmenter"] = nil
    package.loaded["kagiroi/kagiroi_translator"] = nil
    package.loaded["kagiroi/char_variants"] = nil
    package.preload["kagiroi/kagiroi_translator"] = nil
    package.preload["kagiroi/segmenter"] = function()
        return { is_boundary_internal = function(right_id, left_id)
            if right_id == 0 or left_id == 0 then return true end
            if boundary then return boundary(right_id, left_id) end
            -- observed facts of the real segmenter at the fixed commit:
            -- 千葉(1926)->から格助詞(368) and 格助詞->格助詞 stay inside one
            -- clause even though the matrix has a connection value
            if right_id == 1926 and left_id == 368 then return false end
            if right_id == 368 and left_id == 368 then return false end
            return matrix[right_id .. " " .. left_id] ~= nil
        end }
    end
    package.preload["kagiroi/kagiroi_translator"] = function()
        return {
            init = function(env)
                env.tag = "kagiroi"
                env.hira2kata_opencc = function() return { convert = function(_, text) return synth.hira2kata(text) end } end
                env.mem = synth_env.mem
                env.viterbi = viterbi
            end,
            fini = function() end,
            func = function(input, seg, env)
                if type(readings[input]) == "function" then return readings[input](seg, env) end
                for _, offered in ipairs(readings[input] or {}) do
                    local candidate = Candidate("kagiroi", seg.start, seg._end, offered.text, "")
                    candidate.phrase = offered.phrase
                    yield(candidate)
                end
            end,
        }
    end
    local bunsetsu = dofile(bunsetsu_path)
    local segment = { selected_index = 0 }
    local context = { options = {}, properties = {} }
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
                        for candidate in coroutine.wrap(function()
                            bunsetsu.func(value, seg, table.translator_env)
                        end) do
                            yield(candidate)
                            if type(expand_emoji) == "function" then
                                expand_emoji(candidate)
                            elseif expand_emoji and candidate.text == "朱" then
                                yield(ShadowCandidate(candidate, "simplified", "🔴", ""))
                            end
                        end
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
    local env = { engine = { context = context }, mem = synth_env.mem }
    bunsetsu.init(env)
    context.translator_env = env
    return bunsetsu, context, viterbi
end

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

-- Brute-force reference: enumerate every clause-covering lattice path,
-- score it under the same context terms, keep the best route per
-- (text, left id, right id), and return them in score order.
local function reference_paths(viterbi, reading, matrix, context)
    local length = utf8.len(reading)
    local env_matrix = function(right_id, left_id)
        local cost = matrix[right_id .. " " .. left_id]
        if cost == nil then return nil end
        return cost
    end
    local left_term = function(left_id)
        if context.at_start then
            local bos, penalty = env_matrix(0, left_id), env_matrix(-10, left_id)
            if not bos or not penalty then return nil end
            return bos + penalty
        end
        return env_matrix(context.prev_right_id, left_id)
    end
    local right_term = function(right_id)
        if context.at_end then
            local eos, penalty = env_matrix(right_id, 0), env_matrix(right_id, -20)
            if not eos or not penalty then return nil end
            return eos + penalty
        end
        return env_matrix(right_id, context.next_left_id)
    end
    local starting = {}
    for position = 1, length do
        for _, node in ipairs(viterbi.lattice[position] or {}) do
            starting[node.start] = starting[node.start] or {}
            table.insert(starting[node.start], node)
        end
    end
    local best = {}
    local function walk(node, text, own, first_left)
        if node._end == length then
            local term = right_term(node.right_id)
            if term then
                local key = text .. "|" .. first_left .. " " .. node.right_id
                local score = own + term
                if not best[key] or score < best[key].score then
                    best[key] = { text = text, left_id = first_left, right_id = node.right_id,
                        own = own, score = score }
                end
            end
            return
        end
        for _, next_node in ipairs(starting[node._end + 1] or {}) do
            local conn = env_matrix(node.right_id, next_node.left_id)
            if conn then
                walk(next_node, text .. next_node.candidate,
                    own + conn + next_node.wcost, first_left)
            end
        end
    end
    for _, node in ipairs(starting[1] or {}) do
        local term = left_term(node.left_id)
        if term then
            walk(node, node.candidate, term + node.wcost, node.left_id)
        end
    end
    local list = {}
    for _, item in pairs(best) do list[#list + 1] = item end
    table.sort(list, function(a, b) return a.score < b.score end)
    return list
end

local function scored_keys_of(clause)
    local keys = {}
    for _, choice in ipairs(clause.unfiltered) do
        if choice.own ~= nil then
            keys[#keys + 1] = choice.text .. "|" .. choice.left_id .. " " .. choice.right_id
        end
    end
    return keys
end

local function scored_head(clause, count)
    local keys = scored_keys_of(clause)
    local head = {}
    for index = 1, math.min(count, #keys) do head[#head + 1] = keys[index] end
    return head
end

local function reference_head(reference, count)
    local head = {}
    for index = 1, math.min(count, #reference) do
        local item = reference[index]
        head[#head + 1] = item.text .. "|" .. item.left_id .. " " .. item.right_id
    end
    return head
end

-- The whole scored list must follow the brute-force reference: every
-- scored route's contextual score equals the reference value for the same
-- key, and the routes appear in the reference's score order over the
-- entire list, including deep-page positions. Routes with equal reference
-- scores keep their local order (the SPEC leaves it open), so the rank
-- check runs once per distinct score group only.
local function check_scored_matches_reference(clause, reference, matrix, context, label)
    local function boundary_terms(left_id, right_id)
        local left_term = context.at_start
            and matrix["0 " .. left_id] + matrix["-10 " .. left_id]
            or matrix[context.prev_right_id .. " " .. left_id]
        local right_term = context.at_end
            and matrix[right_id .. " 0"] + matrix[right_id .. " -20"]
            or matrix[right_id .. " " .. context.next_left_id]
        return left_term, right_term
    end
    local reference_rank, reference_score = {}, {}
    for rank, item in ipairs(reference) do
        local key = item.text .. "|" .. item.left_id .. " " .. item.right_id
        reference_rank[key] = rank
        reference_score[key] = item.score
    end
    local follows_reference_order, scores_match = true, true
    local previous_rank, last_reference_score = 0
    for _, choice in ipairs(clause.unfiltered) do
        if choice.own ~= nil then
            local key = choice.text .. "|" .. choice.left_id .. " " .. choice.right_id
            local left_term, right_term = boundary_terms(choice.left_id, choice.right_id)
            local score = reference_score[key]
            if score == nil then
                follows_reference_order = false
            else
                if score ~= choice.own + left_term + right_term then scores_match = false end
                if last_reference_score ~= score then
                    local rank = reference_rank[key]
                    if rank == nil or rank < previous_rank then follows_reference_order = false end
                    if rank and rank > previous_rank then previous_rank = rank end
                    last_reference_score = score
                end
            end
        end
    end
    check(follows_reference_order,
        label .. ": the whole scored list follows the brute-force reference order")
    check(scores_match,
        label .. ": every scored route's contextual score equals the brute-force reference")
end

-- The deduped display list must order every displayed text at its best
-- route's cost: the per-text best reference scores ascend through the
-- list; equal-cost texts keep their local order (the SPEC leaves it open).
local function check_display_texts_match_reference(clause, reference, label)
    local best_score = {}
    for _, item in ipairs(reference) do
        local current = best_score[item.text]
        if not current or item.score < current then best_score[item.text] = item.score end
    end
    local follows_reference_order = true
    local previous_score
    for _, choice in ipairs(clause.candidates) do
        local score = best_score[choice.text]
        if score then
            if previous_score ~= nil and score < previous_score then
                follows_reference_order = false
            end
            previous_score = score
        end
    end
    check(follows_reference_order,
        label .. ": the display list orders every text at its best route's cost")
    return best_score
end

-- First raw row of one display text, or nil when the text is absent.
local function text_first_row(clause, text)
    for _, choice in ipairs(clause.unfiltered) do
        if choice.text == text then return choice end
    end
    return nil
end

-- Every demanded stock text stays in the display list and gets a real
-- route score somewhere in its raw rows, beyond any head-rank cap.
local function check_stock_texts_scored_displayed(clause, stock_texts, label)
    local unscored, missing = {}, {}
    for _, text in ipairs(stock_texts) do
        local scored, displayed = false, false
        for _, choice in ipairs(clause.unfiltered) do
            if choice.text == text then
                if choice.own ~= nil then scored = true end
            end
        end
        for _, choice in ipairs(clause.candidates) do
            if choice.text == text then displayed = true break end
        end
        if not scored then unscored[#unscored + 1] = text end
        if not displayed then missing[#missing + 1] = text end
    end
    check(#unscored == 0,
        label .. ": every stock text keeps a route-level score (" .. #unscored .. " unscored)")
    check(#missing == 0,
        label .. ": every stock text stays in the display list (" .. #missing .. " missing)")
end

print("== 1. un-analyzed viterbi still takes the full-path branch first")
do
    local dict = {
        { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
        { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
        { surface = "とうきょう", candidate = "東京", left_id = 1927, right_id = 1927, cost = 0 },
        { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
    }
    local readings = {}
    local bunsetsu, context, viterbi = new_engine(dict, real_matrix, readings)
    check(viterbi.eos == nil, "the fresh viterbi has no eos before any analyze")
    bunsetsu.start(context, "ちばからとうきょう")
    local state = bunsetsu.state(context)
    check(state.contextual == true,
        "the first conversion enters the contextual branch even before any prior analyze")
    check(state.clauses[1].reading == "ちばから" and state.clauses[2].reading == "とうきょう",
        "the clause mapping follows the full path (千葉から | 東京)")
    check(bunsetsu.display(context) == "千葉から東京",
        "the initial display joins the full-path clause texts")
end

print("== 2. multi-word clause keeps same-text different-boundary-id routes")
do
    -- Clause ちばから maps to one clause (1926->368 is internal). The
    -- joined text 千葉から has two routes: [千葉|から368] and [千葉|から330].
    -- Switching the next clause to a candidate whose left id rewards 330
    -- must promote the 330 route; best_n alone cannot list it.
    local matrix = {}
    for key, cost in pairs(real_matrix) do matrix[key] = cost end
    matrix["368 500"] = 50000
    matrix["330 500"] = 10
    matrix["1851 500"] = 30000
    matrix["0 500"] = 4000
    matrix["-10 500"] = 10
    matrix["500 0"] = 0
    matrix["500 -20"] = 100
    local dict = {
        { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
        { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
        { surface = "から", candidate = "から", left_id = 330, right_id = 330, cost = 4000 },
        { surface = "とうきょう", candidate = "東京", left_id = 1927, right_id = 1927, cost = 0 },
        { surface = "とうきょう", candidate = "トウキョウ", left_id = 500, right_id = 500, cost = 3000 },
        { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
    }
    local readings = {
        ["とうきょう"] = {
            { text = "東京", phrase = { text = "東京|1927 1927", custom_code = "とうきょう " } },
            { text = "トウキョウ", phrase = { text = "トウキョウ|500 500", custom_code = "とうきょう " } },
        },
    }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "ちばからとうきょう")
    local state = bunsetsu.state(context)
    check(state.clauses[1].reading == "ちばから",
        "the initial path keeps ちばから as one clause")
    local clause1 = state.clauses[1]
    local aka_keys = {}
    for _, choice in ipairs(clause1.unfiltered) do
        if choice.text == "千葉から" then
            aka_keys[#aka_keys + 1] = choice.left_id .. "-" .. choice.right_id .. ":" .. tostring(choice.own)
        end
    end
    print("  千葉から routes before neighbor switch: " .. table.concat(aka_keys, ", "))
    local has_368, has_330 = false, false
    for _, choice in ipairs(clause1.unfiltered) do
        if choice.text == "千葉から" and choice.right_id == 368 and choice.own ~= nil then has_368 = true end
        if choice.text == "千葉から" and choice.right_id == 330 and choice.own ~= nil then has_330 = true end
    end
    check(has_368 and has_330, "both 千葉から boundary-id routes exist with own costs (1926-368, 1926-330)")

    -- reference under the initial context (next = 東京 1927)
    viterbi:analyze("ちばから")
    local reference_initial = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 1927 })
    check_scored_matches_reference(clause1, reference_initial, matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 1927 }, "initial context")

    -- switch the next clause to トウキョウ (left id 500): 330 route must win
    state.active = 2
    context:set_option("_kagiroi_hide_candidates", false)
    bunsetsu.render(context)
    bunsetsu.select(context, 1)
    local tori = state.clauses[2]
    check(tori.candidates[tori.selected].text == "トウキョウ",
        "selecting the next candidate switches clause2 to トウキョウ")
    state.active = 1
    bunsetsu.render(context)
    local head_after = scored_head(clause1, 3)
    print("  clause1 scored head after neighbor switch: " .. table.concat(head_after, ", "))
    check(head_after[1] == "千葉から|1926 330",
        "the 330 route of 千葉から ranks first once the right neighbor rewards it")
    local reference_switched = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 500 })
    check_scored_matches_reference(clause1, reference_switched, matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 500 }, "switched context")
    check(bunsetsu.display(context) ~= "" and state.clauses[2].candidates[state.clauses[2].selected].text == "トウキョウ",
        "the neighbor clause keeps the switched display トウキョウ")
end

print("== 3. beyond-cap candidate is recovered when the context rewards it")
do
    -- 29 fillers hold the target at isolated rank 31, past the head ranks
    -- of both the assembly scan and the path enumeration; the next
    -- clause's 500-id candidate rewards the target's right connection, so
    -- the contextual order must lift it to the head of the whole list.
    local dict = {
        { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
        { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
        { surface = "から", candidate = "空", left_id = 1851, right_id = 1851, cost = 5511 },
        { surface = "とうきょう", candidate = "東京", left_id = 1927, right_id = 1927, cost = 0 },
        { surface = "とうきょう", candidate = "トウキョウ", left_id = 500, right_id = 500, cost = 3000 },
        { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
    }
    for index = 1, 29 do
        dict[#dict + 1] = { surface = "ちば", candidate = "埋" .. index, left_id = 1926, right_id = 1926,
            cost = 2000 + index * 100 }
    end
    local matrix = {}
    for key, cost in pairs(real_matrix) do matrix[key] = cost end
    matrix["368 500"] = 50000
    matrix["1851 500"] = 10
    matrix["0 500"] = 4000
    matrix["-10 500"] = 10
    matrix["500 0"] = 0
    matrix["500 -20"] = 100
    local readings = {
        ["ちばから"] = {
            { text = "千葉空", phrase = { text = "千葉空|1926 1851", custom_code = "ちばから " } },
        },
        ["とうきょう"] = {
            { text = "東京", phrase = { text = "東京|1927 1927", custom_code = "とうきょう " } },
            { text = "トウキョウ", phrase = { text = "トウキョウ|500 500", custom_code = "とうきょう " } },
        },
    }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "ちばからとうきょう")
    local state = bunsetsu.state(context)
    check(state.clauses[1].reading == "ちばから" and state.clauses[2].reading == "とうきょう",
        "the reading splits into ちばから | とうきょう")

    viterbi:analyze("ちばから")
    local isolated_rank, isolated_seen = 0, false
    for assem in viterbi:best_n() do
        isolated_rank = isolated_rank + 1
        if assem.candidate == "千葉空" then isolated_seen = true break end
    end
    print("  isolated rank of 千葉空: " .. (isolated_seen and tostring(isolated_rank) or "absent"))
    check(isolated_seen and isolated_rank >= 31,
        "the premise holds: 千葉空 ranks 31st or deeper in isolated conversion")

    local clause1 = state.clauses[1]
    local sora_own
    for _, choice in ipairs(clause1.unfiltered) do
        if choice.text == "千葉空" then sora_own = choice.own end
    end
    print(string.format("  千葉空 own=%s", tostring(sora_own)))
    check(sora_own ~= nil, "千葉空 (1926,1851) carries an own cost from beyond the head ranks")
    local reference_initial = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 1927 })
    check_scored_matches_reference(clause1, reference_initial, matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 1927 }, "initial context")

    -- switch the next clause to トウキョウ (left id 500): 千葉空 must win
    state.active = 2
    context:set_option("_kagiroi_hide_candidates", false)
    bunsetsu.render(context)
    bunsetsu.select(context, 1)
    check(state.clauses[2].candidates[state.clauses[2].selected].text == "トウキョウ",
        "selecting the next candidate switches clause2 to トウキョウ")
    state.active = 1
    bunsetsu.render(context)
    check(clause1.candidates[1].text == "千葉空",
        "the deep-isolated 千葉空 becomes the list head once the right neighbor rewards it")
    local reference_switched = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 500 })
    check_scored_matches_reference(clause1, reference_switched, matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 500 }, "rewarded context")
    local sora_rank
    for index, choice in ipairs(clause1.unfiltered) do
        if choice.text == "千葉空" and choice.own ~= nil then sora_rank = index break end
    end
    check(sora_rank == 1, "千葉空 ranks first among the scored routes under the rewarded context")
    check(bunsetsu.display(context) ~= "" and state.clauses[2].candidates[state.clauses[2].selected].text == "トウキョウ",
        "the neighbor clause keeps the switched display トウキョウ")
end

print("== 4. boundary change over scorable clauses re-ranks the pair")
do
    local matrix = {
        ["0 100"] = 500, ["-10 100"] = 10, ["100 0"] = 0, ["100 -20"] = 30,
        ["0 300"] = 400, ["-10 300"] = 20, ["300 0"] = 0, ["300 -20"] = 40,
        ["0 200"] = 600, ["-10 200"] = 15, ["200 0"] = 0, ["200 -20"] = 30,
        ["0 210"] = 610, ["-10 210"] = 15, ["210 0"] = 0, ["210 -20"] = 5,
        ["0 400"] = 700, ["-10 400"] = 25, ["400 0"] = 0, ["400 -20"] = 50,
        ["100 200"] = 900, ["100 210"] = 50, ["100 400"] = 800,
        ["300 200"] = 100, ["300 210"] = 700,
        ["200 400"] = 200, ["210 400"] = 900, ["200 500"] = 800, ["210 500"] = 50,
        ["100 500"] = 800, ["300 500"] = 80, ["500 0"] = 0, ["500 -20"] = 50,
        ["0 500"] = 700, ["-10 500"] = 25,
        ["400 400"] = 300, ["400 500"] = 400,
    }
    local dict = {
        { surface = "あか", candidate = "赤", left_id = 100, right_id = 100, cost = 1000 },
        { surface = "あか", candidate = "朱", left_id = 300, right_id = 300, cost = 1100 },
        { surface = "とり", candidate = "鳥", left_id = 200, right_id = 200, cost = 200 },
        { surface = "とり", candidate = "取り", left_id = 210, right_id = 210, cost = 100 },
        { surface = "さかな", candidate = "魚", left_id = 400, right_id = 400, cost = 125 },
        { surface = "とりさ", candidate = "鳥舎", left_id = 200, right_id = 400, cost = 150 },
        { surface = "とりさ", candidate = "盤舎", left_id = 210, right_id = 400, cost = 50 },
        { surface = "かな", candidate = "金", left_id = 400, right_id = 400, cost = 80 },
        { surface = "さ", candidate = "佐", left_id = 400, right_id = 400, cost = 9000 },
        { surface = "あ", candidate = "阿", left_id = 100, right_id = 100, cost = 8000 },
    }
    local readings = {
        ["とり"] = {
            { text = "鳥", phrase = { text = "鳥|200 200", custom_code = "とり " } },
            { text = "取り", phrase = { text = "取り|210 210", custom_code = "とり " } },
        },
        ["さかな"] = {
            { text = "魚", phrase = { text = "魚|400 400", custom_code = "さかな " } },
        },
        ["とりさ"] = {
            { text = "鳥舎", phrase = { text = "鳥舎|200 400", custom_code = "とりさ " } },
            { text = "盤舎", phrase = { text = "盤舎|210 400", custom_code = "とりさ " } },
        },
        ["かな"] = {
            { text = "金", phrase = { text = "金|400 400", custom_code = "かな " } },
        },
    }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "あかとりさかな")
    local state = bunsetsu.state(context)
    local split_readings = {}
    for _, clause in ipairs(state.clauses) do split_readings[#split_readings + 1] = clause.reading end
    print("  split: " .. table.concat(split_readings, " | "))
    -- pick 朱 (right id 300) in clause1 so the regenerated とりさ ranks 鳥舎 first
    state.active = 1
    for index, choice in ipairs(state.clauses[1].unfiltered) do
        if choice.text == "朱" then state.clauses[1].selected = index break end
    end
    check(state.clauses[1].candidates[state.clauses[1].selected].text == "朱",
        "clause1 shows the picked 朱 before the boundary change")
    state.active = 2
    bunsetsu.resize(context, -1)
    local reshaped = {}
    for _, clause in ipairs(state.clauses) do reshaped[#reshaped + 1] = clause.reading end
    print("  after resize: " .. table.concat(reshaped, " | "))
    check(state.clauses[2].reading == "とり" and state.clauses[3].reading == "さかな",
        "the boundary move reshapes exactly the two adjacent clauses")
    check(state.clauses[1].candidates[state.clauses[1].selected].text == "朱",
        "clause1 keeps its selected display 朱 through the boundary change")
    local tori_clause = state.clauses[2]
    check(tori_clause.unfiltered[1].text == "鳥" and tori_clause.unfiltered[1].own ~= nil,
        "the regenerated とり clause is scored and ranks 鳥 first under 朱's right id 300")
    check(bunsetsu.display(context) == "朱鳥魚",
        "the display joins the re-ranked first candidates")
    viterbi:analyze("とり")
    local reference = reference_paths(viterbi, "とり", matrix,
        { at_start = false, at_end = false, prev_right_id = 300, next_left_id = 400 })
    local got = scored_head(tori_clause, math.min(30, #reference))
    check(table.concat(got, "|") == table.concat(reference_head(reference, math.min(30, #reference)), "|"),
        "the regenerated clause order equals the brute-force reference")
end

print("== 5. generation / re-rank cost and counts on a larger input")
do
    local dict = {}
    local chunks = { "あか", "とり", "さかな", "うみ", "そら", "やま", "かわ", "もり", "いし", "はな" }
    local texts = { "赤", "朱", "紅", "茜" }
    for chunk_index, chunk in ipairs(chunks) do
        for text_index, text in ipairs(texts) do
            dict[#dict + 1] = {
                surface = chunk,
                candidate = text .. chunk_index,
                left_id = 100 + text_index,
                right_id = 100 + text_index,
                cost = 500 + text_index * 50,
            }
        end
    end
    local matrix = {
        ["0 101"] = 500, ["-10 101"] = 10, ["101 0"] = 0, ["101 -20"] = 30,
        ["0 102"] = 500, ["-10 102"] = 10, ["102 0"] = 0, ["102 -20"] = 30,
        ["0 103"] = 500, ["-10 103"] = 10, ["103 0"] = 0, ["103 -20"] = 30,
        ["0 104"] = 500, ["-10 104"] = 10, ["104 0"] = 0, ["104 -20"] = 30,
        ["101 101"] = 900, ["101 102"] = 800, ["101 103"] = 700, ["101 104"] = 600,
        ["102 101"] = 800, ["102 102"] = 900, ["102 103"] = 800, ["102 104"] = 700,
        ["103 101"] = 700, ["103 102"] = 800, ["103 103"] = 900, ["103 104"] = 800,
        ["104 101"] = 600, ["104 102"] = 700, ["104 103"] = 800, ["104 104"] = 900,
    }
    local readings = {}
    local bunsetsu, context = new_engine(dict, matrix, readings)
    local reading = table.concat(chunks)
    local clock_start = os.clock()
    bunsetsu.start(context, reading)
    local split_seconds = os.clock() - clock_start
    local state = bunsetsu.state(context)
    local clause_count, candidate_total = #state.clauses, 0
    for _, clause in ipairs(state.clauses) do candidate_total = candidate_total + #clause.unfiltered end
    clock_start = os.clock()
    state.active = math.max(1, math.floor(#state.clauses / 2))
    context:set_option("_kagiroi_hide_candidates", false)
    bunsetsu.render(context)
    bunsetsu.select(context, 1)
    local select_seconds = os.clock() - clock_start
    print(string.format("  reading=%d chars, clauses=%d, candidates total=%d",
        #reading, clause_count, candidate_total))
    print(string.format("  start=%.4fs, select+re-rank=%.4fs (synthetic, lua5.4)",
        split_seconds, select_seconds))
    check(split_seconds < 5 and select_seconds < 5,
        "generation and re-rank finish in seconds on the synthetic input")
end

print("== 6. reranking uses the target reading after foreign analyses")
for _, foreign_reading in ipairs({ "とり", "赤鳥" }) do
    local matrix = {
        ["0 100"] = 10, ["-10 100"] = 0, ["100 0"] = 0, ["100 -20"] = 0,
        ["100 100"] = 10,
    }
    local dict = {
        { surface = "あか", candidate = "赤", left_id = 100, right_id = 100, cost = 10 },
        { surface = "あか", candidate = "朱", left_id = 100, right_id = 100, cost = 20 },
        { surface = "とり", candidate = "鳥", left_id = 100, right_id = 100, cost = 10 },
        { surface = "とり", candidate = "鶏", left_id = 100, right_id = 100, cost = 20 },
        { surface = "赤鳥", candidate = "誤表記", left_id = 100, right_id = 100, cost = 1 },
    }
    local readings = {}
    for _, word in ipairs(dict) do
        readings[word.surface] = readings[word.surface] or {}
        table.insert(readings[word.surface], {
            text = word.candidate,
            phrase = { text = word.candidate .. "|100 100", custom_code = word.surface .. " " },
        })
    end
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    context:set_option("_kagiroi_hide_candidates", true)
    bunsetsu.start(context, "あかとり")
    local state = bunsetsu.state(context)
    check(#state.clauses == 2 and state.clauses[1].reading == "あか",
        "foreign=" .. foreign_reading .. ": fixture has two distinct clause readings")
    local before = state.clauses[1].candidates[state.clauses[1].selected].text
    state.active = 2
    viterbi:analyze(foreign_reading)
    bunsetsu.select(context, 1)
    local has_foreign = false
    for _, choice in ipairs(state.clauses[1].unfiltered) do
        if choice.text == "鳥" or choice.text == "鶏" or choice.text == "誤表記" then
            has_foreign = true
        end
    end
    check(not has_foreign,
        "foreign=" .. foreign_reading .. ": reranking never imports another reading's candidates")
    check(state.clauses[1].candidates[state.clauses[1].selected].text == before,
        "foreign=" .. foreign_reading .. ": neighbor selection keeps the untouched clause's display")
end

print("== 7. reranking preserves filtered choices across duplicate routes")
do
    local matrix = {}
    for _, id in ipairs({ 100, 200 }) do
        matrix["0 " .. id], matrix["-10 " .. id] = 10, 0
        matrix[id .. " 0"], matrix[id .. " -20"] = 0, 0
        matrix[id .. " 100"], matrix[id .. " 200"] = 10, 10
    end
    local dict = {
        { surface = "あか", candidate = "赤", left_id = 100, right_id = 100, cost = 10 },
        { surface = "あか", candidate = "赤", left_id = 200, right_id = 200, cost = 15 },
        { surface = "あか", candidate = "朱", left_id = 100, right_id = 100, cost = 20 },
        { surface = "とり", candidate = "鳥", left_id = 100, right_id = 100, cost = 10 },
        { surface = "とり", candidate = "鶏", left_id = 100, right_id = 100, cost = 20 },
    }
    local readings = {
        ["あか"] = {
            { text = "赤", phrase = { text = "赤|100 100", custom_code = "あか " } },
            { text = "朱", phrase = { text = "朱|100 100", custom_code = "あか " } },
            { text = "あか" },
        },
        ["とり"] = {
            { text = "鳥", phrase = { text = "鳥|100 100", custom_code = "とり " } },
            { text = "鶏", phrase = { text = "鶏|100 100", custom_code = "とり " } },
        },
    }
    for _, selected_text in ipairs({ "朱", "あか", "🔴" }) do
        local bunsetsu, context = new_engine(dict, matrix, readings, true)
        context:set_option("_kagiroi_hide_candidates", true)
        bunsetsu.start(context, "あかとり")
        local state = bunsetsu.state(context)
        local clause = state.clauses[1]
        local raw_red_count, filtered_red_count = 0, 0
        for _, choice in ipairs(clause.unfiltered) do
            if choice.text == "赤" then raw_red_count = raw_red_count + 1 end
        end
        for _, choice in ipairs(clause.candidates) do
            if choice.text == "赤" then filtered_red_count = filtered_red_count + 1 end
        end
        check(raw_red_count == 2 and filtered_red_count == 1,
            selected_text .. ": display deduplication merges the two raw red routes")
        for index, choice in ipairs(clause.candidates) do
            if choice.text == selected_text then clause.selected = index break end
        end
        check(clause.candidates[clause.selected].text == selected_text,
            selected_text .. ": the filtered choice starts on the requested display text")
        state.active = 2
        bunsetsu.select(context, 1)
        check(clause.candidates[clause.selected].text == selected_text,
            selected_text .. ": neighbor selection preserves the filtered text rather than the unfiltered index")
        bunsetsu.page(context, 1)
        check(clause.candidates[clause.selected].text == selected_text,
            selected_text .. ": neighbor paging preserves the filtered text rather than the unfiltered index")
    end
end

print("== 8. every connection-id candidate keeps a route-level score over the whole list")
do
    -- 30 fillers push the deepest stock texts past any fixed head rank; the
    -- display-size-driven depth must still score them all, and the deep
    -- premise is asserted on the isolated ranking first.
    local dict = {
        { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
        { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
        { surface = "から", candidate = "空", left_id = 1851, right_id = 1851, cost = 5511 },
        { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
    }
    for index = 1, 30 do
        dict[#dict + 1] = { surface = "ちば", candidate = "埋" .. index, left_id = 1926, right_id = 1926,
            cost = 2000 + index * 100 }
    end
    local matrix = {}
    for key, cost in pairs(real_matrix) do matrix[key] = cost end
    local readings = { ["ちばから"] = {} }
    local function stock_row(text, left_id, right_id)
        readings["ちばから"][#readings["ちばから"] + 1] = {
            text = text,
            phrase = { text = text .. "|" .. left_id .. " " .. right_id, custom_code = "ちばから " },
        }
    end
    stock_row("千葉から", 1926, 368)
    for index = 1, 30 do stock_row("埋" .. index .. "から", 1926, 368) end
    stock_row("千葉空", 1926, 1851)
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "ちばから")
    local state = bunsetsu.state(context)
    check(state.contextual == true and #state.clauses == 1,
        "the single-clause reading converts through the contextual branch")

    viterbi:analyze("ちばから")
    local deepest_rank, deepest_seen = 0, false
    for assem in viterbi:best_n() do
        deepest_rank = deepest_rank + 1
        if assem.candidate == "埋30から" then deepest_seen = true break end
    end
    print("  isolated rank of 埋30から: " .. (deepest_seen and tostring(deepest_rank) or "absent"))
    check(deepest_seen and deepest_rank >= 31,
        "the premise holds: the deepest stock text ranks 31st or deeper in isolated conversion")

    local clause1 = state.clauses[1]
    local stock_texts = { "千葉から", "千葉空" }
    for index = 1, 30 do stock_texts[#stock_texts + 1] = "埋" .. index .. "から" end
    local unscored_stock_texts = {}
    for _, text in ipairs(stock_texts) do
        for _, choice in ipairs(clause1.unfiltered) do
            if choice.text == text and choice.own == nil then
                unscored_stock_texts[#unscored_stock_texts + 1] = text
            end
        end
    end
    check(#unscored_stock_texts == 0,
        "every connection-id stock text keeps a route-level score (" .. #unscored_stock_texts .. " unscored)")
    local displayed = {}
    for _, choice in ipairs(clause1.candidates) do displayed[choice.text] = true end
    local missing_texts = {}
    for _, text in ipairs(stock_texts) do
        if not displayed[text] then missing_texts[#missing_texts + 1] = text end
    end
    check(#missing_texts == 0, "the display list keeps every stock text (" .. #missing_texts .. " missing)")
    local reference = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = true, prev_right_id = 0, next_left_id = 0 })
    check_scored_matches_reference(clause1, reference, matrix,
        { at_start = true, at_end = true, prev_right_id = 0, next_left_id = 0 }, "whole display")
    local scored_total = 0
    for _, choice in ipairs(clause1.unfiltered) do
        if choice.own ~= nil then scored_total = scored_total + 1 end
    end
    check(scored_total > 30,
        "the scored list itself extends past the first page (" .. scored_total .. " routes)")
end

print("== 9. unscored routes keep their original order after the scored ones")
do
    local dict = {
        { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
        { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
        { surface = "から", candidate = "空", left_id = 1851, right_id = 1851, cost = 5511 },
        { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
    }
    local matrix = {}
    for key, cost in pairs(real_matrix) do matrix[key] = cost end
    local readings = {
        ["ちばから"] = {
            { text = "千葉から", phrase = { text = "千葉から|1926 368", custom_code = "ちばから " } },
            { text = "よみ１" },
            { text = "幻", phrase = { text = "幻|999 999", custom_code = "ちばから " } },
            { text = "よみ２" },
            { text = "チバカラ" },
        },
    }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "ちばから")
    local state = bunsetsu.state(context)
    local clause1 = state.clauses[1]
    local texts = {}
    for _, choice in ipairs(clause1.unfiltered) do texts[#texts + 1] = choice.text end
    print("  unfiltered order: " .. table.concat(texts, ", "))
    check(#clause1.unfiltered == 6,
        "no route is dropped: two scored, one kana-less, one unroutable-id and two reading rows survive")
    check(clause1.unfiltered[1].text == "千葉から" and clause1.unfiltered[1].own ~= nil
        and clause1.unfiltered[2].text == "千葉空" and clause1.unfiltered[2].own ~= nil,
        "the scored routes lead the list in contextual order")
    check(clause1.unfiltered[3].text == "よみ１" and clause1.unfiltered[4].text == "幻"
        and clause1.unfiltered[5].text == "よみ２" and clause1.unfiltered[6].text == "チバカラ",
        "the unscored routes keep their original order after all scored ones")
    check(clause1.unfiltered[4].own == nil,
        "the unroutable-id row 幻|999 999 stays unscored rather than guessed")
    local display_texts = {}
    for _, choice in ipairs(clause1.candidates) do display_texts[#display_texts + 1] = choice.text end
    check(table.concat(display_texts, "|") == "千葉から|千葉空|よみ１|幻|よみ２|チバカラ",
        "the deduped display follows the same scored-then-original order")
    viterbi:analyze("ちばから")
    local reference = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = true, prev_right_id = 0, next_left_id = 0 })
    check_scored_matches_reference(clause1, reference, matrix,
        { at_start = true, at_end = true, prev_right_id = 0, next_left_id = 0 }, "unscored tail")
end

print("== 10. boundary change settles both reshaped sides under each other")
do
    -- Shrinking とりさ into とり | さかな creates a reshaped pair whose
    -- first choices depend on each other: とり favors 鳥 only when さかな
    -- picks 銀, and さかな favors 銀 only when とり picks 鳥. The pair
    -- settles on that mutual choice; a single pass computed under the
    -- pre-selection picks the wrong さかな candidate.
    local matrix = {
        ["0 100"] = 500, ["-10 100"] = 10, ["100 0"] = 0, ["100 -20"] = 30,
        ["0 300"] = 400, ["-10 300"] = 20, ["300 0"] = 0, ["300 -20"] = 30,
        ["0 200"] = 600, ["-10 200"] = 15, ["200 0"] = 0, ["200 -20"] = 30,
        ["0 210"] = 610, ["-10 210"] = 15, ["210 0"] = 0, ["210 -20"] = 5,
        ["0 400"] = 700, ["-10 400"] = 25, ["400 0"] = 0, ["400 -20"] = 50,
        ["0 500"] = 700, ["-10 500"] = 25, ["500 0"] = 0, ["500 -20"] = 40,
        ["100 200"] = 900, ["100 210"] = 1500,
        ["300 200"] = 100, ["300 210"] = 700,
        ["200 400"] = 9000, ["200 500"] = 10,
        ["210 400"] = 10, ["210 500"] = 9000,
        ["500 500"] = 10, ["500 400"] = 5000,
        ["400 400"] = 300, ["400 500"] = 400,
    }
    local dict = {
        { surface = "あか", candidate = "赤", left_id = 100, right_id = 100, cost = 1000 },
        { surface = "あか", candidate = "朱", left_id = 300, right_id = 300, cost = 500 },
        { surface = "とり", candidate = "鳥", left_id = 200, right_id = 200, cost = 200 },
        { surface = "とり", candidate = "取", left_id = 210, right_id = 210, cost = 100 },
        { surface = "とりさ", candidate = "鳥舎", left_id = 200, right_id = 500, cost = 100 },
        { surface = "とりさ", candidate = "盤舎", left_id = 210, right_id = 400, cost = 90 },
        { surface = "さかな", candidate = "金", left_id = 400, right_id = 400, cost = 80 },
        { surface = "さかな", candidate = "銀", left_id = 500, right_id = 500, cost = 60 },
        { surface = "かな", candidate = "鉛", left_id = 400, right_id = 400, cost = 20 },
        { surface = "かな", candidate = "品", left_id = 500, right_id = 500, cost = 60 },
    }
    local readings = {
        ["あか"] = {
            { text = "赤", phrase = { text = "赤|100 100", custom_code = "あか " } },
            { text = "朱", phrase = { text = "朱|300 300", custom_code = "あか " } },
        },
        ["とり"] = {
            { text = "取", phrase = { text = "取|210 210", custom_code = "とり " } },
            { text = "鳥", phrase = { text = "鳥|200 200", custom_code = "とり " } },
        },
        ["とりさ"] = {
            { text = "鳥舎", phrase = { text = "鳥舎|200 500", custom_code = "とりさ " } },
            { text = "盤舎", phrase = { text = "盤舎|210 400", custom_code = "とりさ " } },
        },
        ["さかな"] = {
            { text = "銀", phrase = { text = "銀|500 500", custom_code = "さかな " } },
            { text = "金", phrase = { text = "金|400 400", custom_code = "さかな " } },
        },
        ["かな"] = {
            { text = "鉛", phrase = { text = "鉛|400 400", custom_code = "かな " } },
            { text = "品", phrase = { text = "品|500 500", custom_code = "かな " } },
        },
    }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "あかとりさかな")
    local state = bunsetsu.state(context)
    local split_readings = {}
    for _, clause in ipairs(state.clauses) do split_readings[#split_readings + 1] = clause.reading end
    print("  split: " .. table.concat(split_readings, " | "))
    check(#state.clauses == 3 and state.clauses[1].reading == "あか"
        and state.clauses[2].reading == "とりさ" and state.clauses[3].reading == "かな",
        "the fixture splits into あか | とりさ | かな")
    local red_index
    for index, choice in ipairs(state.clauses[1].unfiltered) do
        if choice.text == "赤" then red_index = index break end
    end
    state.clauses[1].selected = red_index
    check(state.clauses[1].candidates[state.clauses[1].selected].text == "赤",
        "clause1 starts the resize from the selected 赤")
    state.active = 2
    bunsetsu.resize(context, -1)
    check(state.clauses[2].reading == "とり" and state.clauses[3].reading == "さかな",
        "the boundary move reshapes exactly the two adjacent clauses")
    local tori, sakana = state.clauses[2], state.clauses[3]
    check(tori.candidates[tori.selected].text == "鳥" and tori.unfiltered[1].text == "鳥",
        "the reshaped とり selects its contextual first 鳥 under the settled right neighbor")
    check(sakana.candidates[sakana.selected].text == "銀" and sakana.unfiltered[1].text == "銀",
        "the reshaped さかな selects its contextual first 銀 under the settled left neighbor")
    check(state.clauses[1].candidates[state.clauses[1].selected].text == "赤",
        "clause1 keeps its selected display 赤 through the boundary change")
    check(bunsetsu.display(context) == "赤鳥銀",
        "the display joins the settled first candidates")
    viterbi:analyze("とり")
    local tori_reference = reference_paths(viterbi, "とり", matrix,
        { at_start = false, at_end = false, prev_right_id = 100, next_left_id = 500 })
    check_scored_matches_reference(tori, tori_reference, matrix,
        { at_start = false, at_end = false, prev_right_id = 100, next_left_id = 500 }, "settled とり")
    viterbi:analyze("さかな")
    local sakana_reference = reference_paths(viterbi, "さかな", matrix,
        { at_start = false, at_end = true, prev_right_id = 200, next_left_id = 0 })
    check_scored_matches_reference(sakana, sakana_reference, matrix,
        { at_start = false, at_end = true, prev_right_id = 200, next_left_id = 0 }, "settled さかな")
    viterbi:analyze("あか")
    local aka_reference = reference_paths(viterbi, "あか", matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 200 })
    check_scored_matches_reference(state.clauses[1], aka_reference, matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 200 }, "settled neighbor あか")
end

print("== 10b. absorbing the next clause keeps its successor's selection")
do
    local matrix = {
        ["0 100"] = 500, ["-10 100"] = 10, ["100 0"] = 0, ["100 -20"] = 30,
        ["0 300"] = 400, ["-10 300"] = 20, ["300 0"] = 0, ["300 -20"] = 30,
        ["0 400"] = 700, ["-10 400"] = 25, ["400 0"] = 0, ["400 -20"] = 50,
        ["0 401"] = 700, ["-10 401"] = 25, ["401 0"] = 0, ["401 -20"] = 50,
        ["100 400"] = 800, ["300 400"] = 80, ["300 401"] = 90, ["400 300"] = 700,
    }
    local dict = {
        { surface = "あか", candidate = "赤", left_id = 100, right_id = 100, cost = 1000 },
        { surface = "あか", candidate = "朱", left_id = 300, right_id = 300, cost = 500 },
        { surface = "い", candidate = "伊", left_id = 400, right_id = 400, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 300, right_id = 300, cost = 100 },
        { surface = "え", candidate = "絵A", left_id = 400, right_id = 400, cost = 50 },
        { surface = "え", candidate = "絵B", left_id = 401, right_id = 401, cost = 60 },
    }
    local readings = {
        ["あか"] = {
            { text = "赤", phrase = { text = "赤|100 100", custom_code = "あか " } },
            { text = "朱", phrase = { text = "朱|300 300", custom_code = "あか " } },
        },
        ["い"] = { { text = "伊", phrase = { text = "伊|400 400", custom_code = "い " } } },
        ["う"] = { { text = "宇", phrase = { text = "宇|300 300", custom_code = "う " } } },
        ["え"] = {
            { text = "絵A", phrase = { text = "絵A|400 400", custom_code = "え " } },
            { text = "絵B", phrase = { text = "絵B|401 401", custom_code = "え " } },
        },
    }
    local bunsetsu, context = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "あかいうえ")
    local state = bunsetsu.state(context)
    check(#state.clauses == 4 and state.clauses[4].reading == "え",
        "the fixture splits into four clauses ending in え")
    local picture_b_index
    for index, choice in ipairs(state.clauses[4].unfiltered) do
        if choice.text == "絵B" then picture_b_index = index break end
    end
    state.clauses[4].selected = picture_b_index
    check(state.clauses[4].candidates[state.clauses[4].selected].text == "絵B",
        "the last clause starts the resize from the selected 絵B")
    state.active = 2
    bunsetsu.resize(context, 1)
    local reshaped_readings = {}
    for _, clause in ipairs(state.clauses) do reshaped_readings[#reshaped_readings + 1] = clause.reading end
    print("  after absorb: " .. table.concat(reshaped_readings, " | "))
    check(#state.clauses == 3 and state.clauses[2].reading == "いう",
        "extending い absorbs う into いう and removes the absorbed clause")
    check(state.clauses[3].reading == "え"
        and state.clauses[3].candidates[state.clauses[3].selected].text == "絵B",
        "the unreshaped clause after the absorbed boundary keeps its selected 絵B")
    check(state.clauses[2].candidates[state.clauses[2].selected].text == "伊宇"
        and state.clauses[2].unfiltered[1].text == "伊宇",
        "the absorbing clause selects its contextual first 伊宇 ahead of its raw reading")
end

print("== 11. 60+ displayed stock texts all keep a route-level score in best-route order")
do
    -- Two filler families put the display stock at 77 texts, past any fixed
    -- head cap, and the last stock row is the inverted one: a rewarded right
    -- connection makes the 77th stock text the list head. Every stock text
    -- must keep a route-level score, in display order equal to its best
    -- route, no matter how deep it sits.
    local dict = {
        { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
        { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
        { surface = "から", candidate = "空", left_id = 1851, right_id = 1851, cost = 5511 },
        { surface = "とうきょう", candidate = "東京", left_id = 1927, right_id = 1927, cost = 0 },
        { surface = "とうきょう", candidate = "トウキョウ", left_id = 500, right_id = 500, cost = 3000 },
        { surface = "ら", candidate = "良", left_id = 222, right_id = 222, cost = 3000 },
    }
    for index = 1, 45 do
        dict[#dict + 1] = { surface = "ちば", candidate = "埋" .. index, left_id = 1926, right_id = 1926,
            cost = 2100 + index * 5 }
        dict[#dict + 1] = { surface = "か", candidate = "場" .. index, left_id = 1926, right_id = 1926,
            cost = 5000 + index * 10 }
    end
    local matrix = {}
    for key, cost in pairs(real_matrix) do matrix[key] = cost end
    matrix["1926 222"] = 2
    matrix["222 0"] = 5
    matrix["222 -20"] = 7
    matrix["222 1927"] = 50000
    matrix["222 500"] = 50000
    matrix["368 500"] = 50000
    matrix["1851 500"] = 10
    matrix["0 500"] = 4000
    matrix["-10 500"] = 10
    matrix["500 0"] = 0
    matrix["500 -20"] = 100
    local readings = {
        ["とうきょう"] = {
            { text = "東京", phrase = { text = "東京|1927 1927", custom_code = "とうきょう " } },
            { text = "トウキョウ", phrase = { text = "トウキョウ|500 500", custom_code = "とうきょう " } },
        },
    }
    local stock_texts
    do
        local function stock_row(text, left_id, right_id)
            readings["ちばから"] = readings["ちばから"] or {}
            local rows = readings["ちばから"]
            rows[#rows + 1] = {
                text = text,
                phrase = { text = text .. "|" .. left_id .. " " .. right_id, custom_code = "ちばから " },
            }
        end
        stock_row("千葉から", 1926, 368)
        for index = 1, 45 do stock_row("埋" .. index .. "から", 1926, 368) end
        for index = 1, 30 do stock_row("千葉場" .. index .. "良", 1926, 222) end
        stock_row("千葉空", 1926, 1851)
        stock_texts = { "千葉から" }
        for index = 1, 45 do stock_texts[#stock_texts + 1] = "埋" .. index .. "から" end
        for index = 1, 30 do stock_texts[#stock_texts + 1] = "千葉場" .. index .. "良" end
        stock_texts[#stock_texts + 1] = "千葉空"
    end
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "ちばからとうきょう")
    local state = bunsetsu.state(context)
    check(state.clauses[1].reading == "ちばから" and state.clauses[2].reading == "とうきょう",
        "the reading splits into ちばから | とうきょう")

    viterbi:analyze("ちばから")
    local isolated_rank, isolated_seen = 0, false
    for assem in viterbi:best_n() do
        isolated_rank = isolated_rank + 1
        if assem.candidate == "千葉空" then isolated_seen = true break end
    end
    print("  isolated rank of 千葉空: " .. (isolated_seen and tostring(isolated_rank) or "absent"))
    check(isolated_seen and isolated_rank >= 31,
        "the premise holds: 千葉空 ranks 31st or deeper in isolated conversion")

    local clause1 = state.clauses[1]
    check(#clause1.candidates >= 77,
        "the display list holds all 77 stock texts past the old head caps ("
            .. #clause1.candidates .. " texts)")
    check_stock_texts_scored_displayed(clause1, stock_texts, "initial context")
    local scored_total = 0
    for _, choice in ipairs(clause1.unfiltered) do
        if choice.own ~= nil then scored_total = scored_total + 1 end
    end
    check(scored_total > 60,
        "the scored rows extend past the old keys cap (" .. scored_total .. " rows)")
    local reference_initial = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 1927 })
    check_scored_matches_reference(clause1, reference_initial, matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 1927 }, "60+ initial context")
    check_display_texts_match_reference(clause1, reference_initial, "60+ initial context")

    -- switch the next clause to トウキョウ (left id 500): the deepest stock
    -- text must become the display head
    state.active = 2
    context:set_option("_kagiroi_hide_candidates", false)
    bunsetsu.render(context)
    bunsetsu.select(context, 1)
    check(state.clauses[2].candidates[state.clauses[2].selected].text == "トウキョウ",
        "selecting the next candidate switches clause2 to トウキョウ")
    state.active = 1
    bunsetsu.render(context)
    check(clause1.candidates[1].text == "千葉空",
        "the deepest stock text ranks first once the right neighbor rewards it")
    local reference_switched = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 500 })
    check_scored_matches_reference(clause1, reference_switched, matrix,
        { at_start = true, at_end = false, prev_right_id = 0, next_left_id = 500 }, "60+ rewarded context")
    check_display_texts_match_reference(clause1, reference_switched, "60+ rewarded context")
    check_stock_texts_scored_displayed(clause1, stock_texts, "60+ rewarded context")
    check(bunsetsu.display(context) ~= ""
        and state.clauses[2].candidates[state.clauses[2].selected].text == "トウキョウ",
        "the neighbor clause keeps the switched display トウキョウ")
end

print("== 12. a same-text id pair beyond the discovery head still materializes and can win")
do
    -- The 千葉から text has three same-text routes: 368 (the stock row's
    -- pair), 330 and 777. The 777 route's key lands beyond the enumeration
    -- head cap over the 40 filler composites, so only a per-pair search
    -- keeps it ranked: under the third neighborhood it must own the text's
    -- display position.
    local dict = {
        { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
        { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
        { surface = "から", candidate = "から", left_id = 330, right_id = 330, cost = 4000 },
        { surface = "から", candidate = "から", left_id = 777, right_id = 777, cost = 7000 },
        { surface = "から", candidate = "空", left_id = 1851, right_id = 1851, cost = 5511 },
        { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
        { surface = "とうきょう", candidate = "東京", left_id = 1927, right_id = 1927, cost = 0 },
        { surface = "とうきょう", candidate = "トウキョウ", left_id = 500, right_id = 500, cost = 3000 },
        { surface = "とうきょう", candidate = "トカツ", left_id = 400, right_id = 400, cost = 1000 },
    }
    for index = 1, 40 do
        dict[#dict + 1] = { surface = "ちば", candidate = "埋" .. index, left_id = 1926, right_id = 1926,
            cost = 2000 + index * 100 }
    end
    local matrix = {}
    for key, cost in pairs(real_matrix) do matrix[key] = cost end
    matrix["1926 330"] = 10
    matrix["1926 777"] = 30
    matrix["777 1927"] = 99999
    matrix["777 500"] = 100
    matrix["777 400"] = 1
    matrix["368 500"] = 50000
    matrix["368 400"] = 50000
    matrix["330 400"] = 50000
    matrix["330 500"] = 4
    matrix["1851 500"] = 10
    matrix["1851 400"] = 100
    matrix["0 500"] = 4000
    matrix["-10 500"] = 10
    matrix["500 0"] = 0
    matrix["500 -20"] = 100
    matrix["0 400"] = 4000
    matrix["-10 400"] = 10
    matrix["400 0"] = 0
    matrix["400 -20"] = 10
    local readings = {
        ["とうきょう"] = {
            { text = "東京", phrase = { text = "東京|1927 1927", custom_code = "とうきょう " } },
            { text = "トウキョウ", phrase = { text = "トウキョウ|500 500", custom_code = "とうきょう " } },
            { text = "トカツ", phrase = { text = "トカツ|400 400", custom_code = "とうきょう " } },
        },
    }
    readings["ちばから"] = {
        { text = "千葉から", phrase = { text = "千葉から|1926 368", custom_code = "ちばから " } },
    }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "ちばからとうきょう")
    local state = bunsetsu.state(context)
    local clause1 = state.clauses[1]

    viterbi:analyze("ちばから")
    local route_own_rows = {}
    for _, choice in ipairs(clause1.unfiltered) do
        if choice.text == "千葉から" and choice.own ~= nil then
            route_own_rows[choice.left_id .. " " .. choice.right_id] = choice.own
        end
    end
    for _, ids in ipairs({ "1926 368", "1926 330", "1926 777" }) do
        check(route_own_rows[ids] ~= nil,
            "the route 1926-" .. ids:sub(-3) .. " of 千葉から is materialized and scored (own "
                .. tostring(route_own_rows[ids]) .. ")")
    end

    local switches = {
        { neighbor = "東京", next_left_id = 1927, label = "initial context", first = "1926 368", skip_walk = true },
        { neighbor = "トカツ", next_left_id = 400, label = "third context", first = "1926 777" },
        { neighbor = "トウキョウ", next_left_id = 500, label = "rewarded context", first = "1926 330" },
    }
    for _, switch_spec in ipairs(switches) do
        local clause2 = state.clauses[2]
        if not switch_spec.skip_walk then
            state.active = 2
            context:set_option("_kagiroi_hide_candidates", false)
            bunsetsu.render(context)
            bunsetsu.select(context, 1)
        end
        check(state.clauses[2].candidates[state.clauses[2].selected].text == switch_spec.neighbor,
            switch_spec.label .. ": clause2 switches to " .. switch_spec.neighbor)
        state.active = 1
        bunsetsu.render(context)
        viterbi:analyze("ちばから")
        local first_row = text_first_row(clause1, "千葉から")
        check(first_row and first_row.left_id .. " " .. first_row.right_id == switch_spec.first,
            switch_spec.label .. ": the text から displays its best route pair ("
                .. tostring(first_row and first_row.left_id .. " " .. first_row.right_id) .. ")")
        local reference = reference_paths(viterbi, "ちばから", matrix,
            { at_start = true, at_end = false, prev_right_id = 0, next_left_id = switch_spec.next_left_id })
        check_scored_matches_reference(clause1, reference, matrix,
            { at_start = true, at_end = false, prev_right_id = 0, next_left_id = switch_spec.next_left_id },
            switch_spec.label)
        check_display_texts_match_reference(clause1, reference, switch_spec.label)
    end
end

print("== 13. pair-less display rows keep no own while their text stays scored")
do
    -- The display stock rows spell 1926 111, a boundary pair with no
    -- lattice route at all; the texts' real routes are 1926 368 and
    -- 1926 1851. The pair-less rows must stay unscored instead of carrying
    -- another route's own, and each text must display its real route.
    local dict = {
        { surface = "ちば", candidate = "千葉", left_id = 1926, right_id = 1926, cost = 1545 },
        { surface = "から", candidate = "から", left_id = 368, right_id = 368, cost = 0 },
        { surface = "から", candidate = "空", left_id = 1851, right_id = 1851, cost = 5511 },
        { surface = "ち", candidate = "知", left_id = 1851, right_id = 1851, cost = 6000 },
    }
    local matrix = {}
    for key, cost in pairs(real_matrix) do matrix[key] = cost end
    matrix["111 0"] = 5
    matrix["111 -20"] = 7
    local readings = {
        ["ちばから"] = {
            { text = "千葉から", phrase = { text = "千葉から|1926 111", custom_code = "ちばから " } },
            { text = "千葉空", phrase = { text = "千葉空|1926 111", custom_code = "ちばから " } },
            { text = "よみ１" },
            { text = "幻", phrase = { text = "幻|999 999", custom_code = "ちばから " } },
            { text = "チバカラ" },
        },
    }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "ちばから")
    local state = bunsetsu.state(context)
    local clause1 = state.clauses[1]
    for _, choice in ipairs(clause1.unfiltered) do
        print("  row: " .. choice.text .. " ids=" .. tostring(choice.left_id) .. "/"
            .. tostring(choice.right_id) .. " own=" .. tostring(choice.own))
    end
    viterbi:analyze("ちばから")
    local reference = reference_paths(viterbi, "ちばから", matrix,
        { at_start = true, at_end = true, prev_right_id = 0, next_left_id = 0 })
    local pairless_own
    for _, choice in ipairs(clause1.unfiltered) do
        if choice.left_id == 1926 and choice.right_id == 111 then
            pairless_own = pairless_own or choice.own
        end
    end
    check(pairless_own == nil,
        "the stock pairs 1926 111 spell no route and keep no own")
    check(text_first_row(clause1, "千葉から").right_id == 368,
        "the text 千葉から displays its real 1926 368 route")
    check(text_first_row(clause1, "千葉空").right_id == 1851,
        "the text 千葉空 displays its real 1926 1851 route")
    local display_texts = {}
    for _, choice in ipairs(clause1.candidates) do display_texts[#display_texts + 1] = choice.text end
    check(table.concat(display_texts, "|") == "千葉から|千葉空|よみ１|幻|チバカラ",
        "the pair-less rows do not drag their texts out of the scored order")
    check_scored_matches_reference(clause1, reference, matrix,
        { at_start = true, at_end = true, prev_right_id = 0, next_left_id = 0 }, "pair-less rows")
    check_display_texts_match_reference(clause1, reference, "pair-less rows")
end

print("== 14. a reshaped pair through a five-round joint stair still settles both sides")
do
    -- Shrinking とり差 into とり | さ regenerates both clauses over 5-ish
    -- candidates whose joint costs form a staircase: each round changes
    -- exactly one side, and the fixed point lies past a three-round cap.
    -- Both sides must end as contextual firsts under each other's final
    -- selections (朱 keeps shaping the left boundary as 300).
    local matrix = {
        ["0 300"] = 10, ["-10 300"] = 0, ["300 0"] = 3, ["300 -20"] = 4,
        ["0 100"] = 30, ["-10 100"] = 0, ["100 0"] = 3, ["100 -20"] = 4,
        ["0 299"] = 60, ["-10 299"] = 2, ["300 299"] = 500,
        ["399 0"] = 5, ["399 -20"] = 7,
        ["300 201"] = 30, ["300 202"] = 30, ["300 203"] = 30, ["300 204"] = 30, ["300 205"] = 30,
        ["201 0"] = 5, ["201 -20"] = 7, ["202 0"] = 5, ["202 -20"] = 7,
        ["203 0"] = 5, ["203 -20"] = 7, ["204 0"] = 5, ["204 -20"] = 7,
        ["205 0"] = 5, ["205 -20"] = 7,
        ["301 0"] = 5, ["301 -20"] = 7, ["302 0"] = 5, ["302 -20"] = 7,
        ["303 0"] = 5, ["303 -20"] = 7, ["304 0"] = 5, ["304 -20"] = 7,
        ["305 0"] = 5, ["305 -20"] = 7,
        ["201 301"] = 90, ["201 302"] = 95, ["201 303"] = 96, ["201 304"] = 97, ["201 305"] = 97,
        ["202 301"] = 80, ["202 302"] = 70, ["202 303"] = 85, ["202 304"] = 80, ["202 305"] = 82,
        ["203 301"] = 95, ["203 302"] = 65, ["203 303"] = 55, ["203 304"] = 75, ["203 305"] = 66,
        ["204 301"] = 96, ["204 302"] = 72, ["204 303"] = 45, ["204 304"] = 35, ["204 305"] = 67,
        ["205 301"] = 97, ["205 302"] = 74, ["205 303"] = 50, ["205 304"] = 25, ["205 305"] = 15,
    }
    for index = 1, 5 do
        matrix["0 " .. (200 + index)] = 40
        matrix["-10 " .. (200 + index)] = 1
        matrix["0 " .. (300 + index)] = 40
        matrix["-10 " .. (300 + index)] = 1
    end
    local dict = {
        { surface = "あか", candidate = "朱", left_id = 300, right_id = 300, cost = 100 },
        { surface = "あか", candidate = "赤", left_id = 100, right_id = 100, cost = 2000 },
        { surface = "とりさ", candidate = "鳥差", left_id = 299, right_id = 399, cost = 50 },
    }
    for index = 1, 5 do
        dict[#dict + 1] = {
            surface = "とり", candidate = "取" .. index, left_id = 200 + index, right_id = 200 + index,
            cost = 500,
        }
        dict[#dict + 1] = {
            surface = "さ", candidate = "魚" .. index, left_id = 300 + index, right_id = 300 + index,
            cost = 500,
        }
    end
    local readings = {
        ["あか"] = {
            { text = "朱", phrase = { text = "朱|300 300", custom_code = "あか " } },
            { text = "赤", phrase = { text = "赤|100 100", custom_code = "あか " } },
        },
        ["とりさ"] = {
            { text = "鳥差", phrase = { text = "鳥差|299 399", custom_code = "とりさ " } },
        },
    }
    for index = 1, 5 do
        readings["とり"] = readings["とり"] or {}
        readings["とり"][#readings["とり"] + 1] = {
            text = "取" .. index,
            phrase = { text = "取" .. index .. "|" .. (200 + index) .. " " .. (200 + index),
                custom_code = "とり " },
        }
        readings["さ"] = readings["さ"] or {}
        readings["さ"][#readings["さ"] + 1] = {
            text = "魚" .. index,
            phrase = { text = "魚" .. index .. "|" .. (300 + index) .. " " .. (300 + index),
                custom_code = "さ " },
        }
    end
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "あかとりさ")
    local state = bunsetsu.state(context)
    check(#state.clauses == 2 and state.clauses[2].reading == "とりさ",
        "the fixture splits into あか | とりさ")
    check(state.clauses[1].candidates[state.clauses[1].selected].text == "朱",
        "clause1 starts the resize from the selected 朱")
    state.active = 2
    bunsetsu.resize(context, -1)
    check(state.clauses[2].reading == "とり" and state.clauses[3].reading == "さ",
        "the boundary move reshapes exactly the two adjacent clauses")
    local tori, sakana = state.clauses[2], state.clauses[3]
    check(tori.candidates[tori.selected].text == "取5" and tori.unfiltered[1].text == "取5",
        "the reshaped とり is the mutually-settled 取5 (numeric flag: five rounds needed)")
    check(sakana.candidates[sakana.selected].text == "魚5" and sakana.unfiltered[1].text == "魚5",
        "the reshaped さ is the mutually-settled 魚5 under the settled left neighbor")
    check(state.clauses[1].candidates[state.clauses[1].selected].text == "朱",
        "clause1 keeps its selected display 朱 through the boundary change")
    check(bunsetsu.display(context) == "朱取5魚5",
        "the display joins the settled first candidates")
    viterbi:analyze("とり")
    local tori_reference = reference_paths(viterbi, "とり", matrix,
        { at_start = false, at_end = false, prev_right_id = 300, next_left_id = 305 })
    check_scored_matches_reference(tori, tori_reference, matrix,
        { at_start = false, at_end = false, prev_right_id = 300, next_left_id = 305 }, "settled とり")
    viterbi:analyze("さ")
    local sakana_reference = reference_paths(viterbi, "さ", matrix,
        { at_start = false, at_end = true, prev_right_id = 205, next_left_id = 0 })
    check_scored_matches_reference(sakana, sakana_reference, matrix,
        { at_start = false, at_end = true, prev_right_id = 205, next_left_id = 0 }, "settled さ")
end

print("== 15. stock prefix stream beyond 512 remains fully scored")
do
    local dict, matrix = {}, {
        ["0 368"] = 0, ["-10 368"] = 0, ["368 368"] = 0,
        ["368 0"] = 0, ["368 -20"] = 0,
    }
    for index = 1, 49 do
        dict[#dict + 1] = { surface = "あ", candidate = utf8.char(0x4e00 + index),
            left_id = 368, right_id = 368, cost = 100 + index }
    end
    local reading = string.rep("あ", 14)
    local stock_texts, prefix_count, last_full_position = {}, 0, 0
    local readings = {}
    readings[reading] = function(seg, env)
        for assembly in env.viterbi:best_n_prefix() do
            prefix_count = prefix_count + 1
            if assembly.surface == reading then
                stock_texts[#stock_texts + 1] = assembly.candidate
                last_full_position = prefix_count
                local candidate = Candidate("kagiroi", seg.start, seg._end, assembly.candidate, "")
                candidate.phrase = { text = assembly.candidate .. "|" .. assembly.left_id .. " " .. assembly.right_id,
                    custom_code = reading .. " " }
                yield(candidate)
            end
        end
    end
    local bunsetsu, context = new_engine(dict, matrix, readings)
    local started = os.clock()
    bunsetsu.start(context, reading)
    local clause = bunsetsu.state(context).clauses[1]
    print(string.format("  prefix stream %d / full-cover stock %d / %.3fs", prefix_count, #stock_texts, os.clock() - started))
    print("  last full-cover prefix position " .. last_full_position)
    check(prefix_count > 512 and last_full_position > 512,
        "the real upstream prefix stream includes a full-cover stock row beyond position 512")
    check_stock_texts_scored_displayed(clause, stock_texts, "512+ prefix stream")
    local expected_cost = {}
    for _, text in ipairs(stock_texts) do
        local cost = 0
        for _, codepoint in utf8.codes(text) do cost = cost + 100 + codepoint - 0x4e00 end
        expected_cost[text] = cost
    end
    local costs_match = true
    for _, choice in ipairs(clause.unfiltered) do
        if expected_cost[choice.text] and choice.own ~= expected_cost[choice.text] then costs_match = false end
    end
    check(costs_match, "all prefix-stock own costs equal the independent sum of their character costs")
end

print("== 16. many same-text id routes cannot consume another text's scoring slots")
do
    local dict, matrix = {}, {}
    for index = 1, 45 do
        local id = 700 + index
        dict[#dict + 1] = { surface = "あ", candidate = "同", left_id = id, right_id = id, cost = 100 + index }
        matrix["0 " .. id], matrix["-10 " .. id] = 0, 0
        matrix[id .. " 0"], matrix[id .. " -20"] = 0, 0
        for second = 1, 45 do matrix[id .. " " .. (700 + second)] = 1 end
    end
    dict[#dict + 1] = { surface = "ああ", candidate = "別", left_id = 800, right_id = 800, cost = 900 }
    matrix["0 800"], matrix["-10 800"], matrix["800 0"], matrix["800 -20"] = 0, 0, 0, 0
    local readings = { ["ああ"] = {
        { text = "同同", phrase = { text = "同同|701 701", custom_code = "ああ " } },
        { text = "別", phrase = { text = "別|800 800", custom_code = "ああ " } },
    } }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings, false, function() return false end)
    local started = os.clock()
    bunsetsu.start(context, "ああ")
    local clause = bunsetsu.state(context).clauses[1]
    viterbi:analyze("ああ")
    local reference = reference_paths(viterbi, "ああ", matrix,
        { at_start = true, at_end = true })
    local wanted, actual = {}, {}
    for _, item in ipairs(reference) do wanted[item.text .. "|" .. item.left_id .. " " .. item.right_id] = true end
    for _, choice in ipairs(clause.unfiltered) do
        if choice.own ~= nil then actual[choice.text .. "|" .. choice.left_id .. " " .. choice.right_id] = true end
    end
    local total, missing = 0, 0
    for key in pairs(wanted) do total = total + 1; if not actual[key] then missing = missing + 1 end end
    print(string.format("  reference pairs %d / missing %d / %.3fs", total, missing, os.clock() - started))
    check(total > 1000 and missing == 0, "every independently enumerated same-text boundary-id pair is scored")
    check_stock_texts_scored_displayed(clause, { "同同", "別" }, "many-id stock")
    check_scored_matches_reference(clause, reference, matrix, { at_start = true, at_end = true }, "many-id stock")
    check_display_texts_match_reference(clause, reference, "many-id stock")
end

print("== 17. a future negative connection cannot be skipped by discovery")
do
    local dict, matrix = {}, {
        ["0 200"] = 0, ["-10 200"] = 0, ["200 300"] = -20000,
        ["300 0"] = 0, ["300 -20"] = 0,
        ["0 100"] = 0, ["-10 100"] = 0, ["100 0"] = 0, ["100 -20"] = 0,
        ["100 600"] = 0, ["100 601"] = 0, ["300 600"] = 100000, ["300 601"] = 0,
        ["0 600"] = 0, ["-10 600"] = 0, ["600 0"] = 0, ["600 -20"] = 0,
        ["0 601"] = 0, ["-10 601"] = 0, ["601 0"] = 0, ["601 -20"] = 0,
    }
    for index = 1, 40 do
        dict[#dict + 1] = { surface = "あい", candidate = "埋" .. index,
            left_id = 100, right_id = 100, cost = 100 + index }
    end
    dict[#dict + 1] = { surface = "あ", candidate = "遅", left_id = 200, right_id = 200, cost = 10000 }
    dict[#dict + 1] = { surface = "い", candidate = "勝", left_id = 300, right_id = 300, cost = 10 }
    dict[#dict + 1] = { surface = "う", candidate = "隣1", left_id = 600, right_id = 600, cost = 0 }
    dict[#dict + 1] = { surface = "う", candidate = "隣2", left_id = 601, right_id = 601, cost = 200000 }
    local readings = {
        ["あい"] = { { text = "あい" } },
        ["う"] = {
            { text = "隣1", phrase = { text = "隣1|600 600", custom_code = "う " } },
            { text = "隣2", phrase = { text = "隣2|601 601", custom_code = "う " } },
        },
    }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings,
        false, function(_, left_id) return left_id == 600 or left_id == 601 end)
    bunsetsu.start(context, "あいう")
    local state = bunsetsu.state(context)
    local clause = state.clauses[1]
    check(state.clauses[2].candidates[state.clauses[2].selected].text == "隣1"
        and text_first_row(clause, "遅勝") == nil,
        "the initially disfavored negative-tail text is neither stock nor the selected full path")
    state.active = 2
    context:set_option("_kagiroi_hide_candidates", false)
    bunsetsu.render(context)
    bunsetsu.select(context, 1)
    check(state.clauses[2].candidates[state.clauses[2].selected].text == "隣2",
        "the next neighbor exposes the negative-tail winner without regenerating the stock list")
    state.active = 1
    bunsetsu.render(context)
    local winner = text_first_row(clause, "遅勝")
    check(winner and winner.own == -9990 and clause.candidates[1].text == "遅勝",
        "the expensive prefix followed by a negative connection is discovered and ranked first")
    viterbi:analyze("あい")
    local score_context = { at_start = true, at_end = false, next_left_id = 601 }
    local reference = reference_paths(viterbi, "あい", matrix, score_context)
    check(reference[1].text == "遅勝" and reference[1].score == -9990,
        "the independent exhaustive reference identifies the same negative-tail winner")
    local covered = {}
    for _, choice in ipairs(clause.unfiltered) do if choice.own ~= nil then covered[choice.text] = true end end
    local missing = 0
    for index = 1, 30 do if not covered[reference[index].text] then missing = missing + 1 end end
    check(missing == 0, "discovery covers every text of the independent contextual head")
    check_scored_matches_reference(clause, reference, matrix, score_context, "negative tail")
end

print("== 18. settling follows route identities through equal-text and equal-cost choices")
do
    local matrix = {
        ["0 299"] = 0, ["-10 299"] = 0, ["399 0"] = 0, ["399 -20"] = 0,
        ["201 301"] = 10, ["201 302"] = 10, ["201 303"] = 10,
        ["202 301"] = 5, ["202 302"] = 3, ["202 303"] = 4,
        ["203 301"] = 8, ["203 302"] = 2, ["203 303"] = 1,
        ["204 301"] = 8, ["204 302"] = 2, ["204 303"] = 1,
    }
    local dict = { { surface = "とりさ", candidate = "元", left_id = 299, right_id = 399, cost = 50 } }
    for id = 201, 204 do
        dict[#dict + 1] = { surface = "とり", candidate = "同", left_id = id, right_id = id, cost = 500 }
        matrix["0 " .. id], matrix["-10 " .. id], matrix[id .. " 0"], matrix[id .. " -20"] = 0, 0, 0, 0
    end
    for id = 301, 303 do
        dict[#dict + 1] = { surface = "さ", candidate = "魚", left_id = id, right_id = id, cost = 500 }
        matrix["0 " .. id], matrix["-10 " .. id], matrix[id .. " 0"], matrix[id .. " -20"] = 0, 0, 0, 0
    end
    local readings = {
        ["とりさ"] = { { text = "元", phrase = { text = "元|299 399", custom_code = "とりさ " } } },
        ["とり"] = { { text = "同", phrase = { text = "同|201 201", custom_code = "とり " } } },
        ["さ"] = { { text = "魚", phrase = { text = "魚|301 301", custom_code = "さ " } } },
    }
    for repeat_index = 1, 3 do
        local bunsetsu, context, viterbi = new_engine(dict, matrix, readings, false, function() return false end)
        bunsetsu.start(context, "とりさ")
        local state = bunsetsu.state(context)
        bunsetsu.resize(context, -1)
        local left, right = state.clauses[1], state.clauses[2]
        check(left.unfiltered[1].left_id == 203 and right.unfiltered[1].left_id == 303,
            "equal-text routes settle beyond their first identity switch, with stable tie order (run " .. repeat_index .. ")")
        check(left.selected == 1 and right.selected == 1 and bunsetsu.display(context) == "同魚",
            "the final filtered selections remain both contextual firsts (run " .. repeat_index .. ")")
        viterbi:analyze("とり")
        local reference = reference_paths(viterbi, "とり", matrix,
            { at_start = true, at_end = false, next_left_id = 303 })
        check_scored_matches_reference(left, reference, matrix,
            { at_start = true, at_end = false, next_left_id = 303 }, "identity-settled left")
        viterbi:analyze("さ")
        reference = reference_paths(viterbi, "さ", matrix,
            { at_start = false, at_end = true, prev_right_id = 203 })
        check_scored_matches_reference(right, reference, matrix,
            { at_start = false, at_end = true, prev_right_id = 203 }, "identity-settled right")
    end
end

print("== 19. stock dictionary routes outside the upstream beam remain scorable")
do
    local dict, readings, stock_texts, reference = {}, { ["あ"] = {} }, {}, {}
    local matrix = { ["0 500"] = 0, ["-10 500"] = 0, ["500 0"] = 0, ["500 -20"] = 0 }
    for index = 1, 65 do
        local text = "深" .. index
        dict[#dict + 1] = { surface = "あ", candidate = text, left_id = 500, right_id = 500, cost = index }
        readings["あ"][#readings["あ"] + 1] = {
            text = text, phrase = { text = text .. "|500 500", custom_code = "あ " },
        }
        stock_texts[#stock_texts + 1] = text
        reference[#reference + 1] = { text = text, left_id = 500, right_id = 500, own = index, score = index }
    end
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    bunsetsu.start(context, "あ")
    local clause = bunsetsu.state(context).clauses[1]
    check(#viterbi.lattice[1] == 50, "the actual upstream lattice retains its production beam width of 50")
    check_stock_texts_scored_displayed(clause, stock_texts, "outside upstream beam")
    check_scored_matches_reference(clause, reference, matrix, { at_start = true, at_end = true }, "outside upstream beam")
    check_display_texts_match_reference(clause, reference, "outside upstream beam")
end

print("== 20. tied exponential path families stay practical and keep the selected route scored")
do
    local dict, matrix = {}, {
        ["0 368"] = 0, ["-10 368"] = 0, ["368 368"] = 0, ["368 0"] = 0, ["368 -20"] = 0,
    }
    for index = 1, 48 do
        dict[#dict + 1] = { surface = "あ", candidate = utf8.char(0x4e00 + index),
            left_id = 368, right_id = 368, cost = 0 }
    end
    local reading = string.rep("あ", 12)
    local bunsetsu, context, viterbi = new_engine(dict, matrix, {})
    viterbi:analyze(reading)
    local best = viterbi:best_n()().candidate
    local started = os.clock()
    bunsetsu.start(context, reading)
    local clause = bunsetsu.state(context).clauses[1]
    local selected = text_first_row(clause, best)
    local elapsed = os.clock() - started
    print(string.format("  48^12 tied paths / %d display texts / %.3fs", #clause.candidates, elapsed))
    check(selected and selected.own == 0, "the selected full-path text stays scored even outside discovery's tied head")
    check(elapsed < 5, "the zero-cost exponential path family finishes within seconds without enumerating every route")
    local distinct, scored = {}, 0
    for _, choice in ipairs(clause.unfiltered) do
        if choice.own ~= nil then distinct[choice.text] = true end
    end
    for _ in pairs(distinct) do scored = scored + 1 end
    check(scored >= 30, "discovery returns its complete unique-text head despite exponentially many tied routes")
end


local function check_final_single_node_scores(state, dictionary, matrix, heads, label)
    local function ids(choice)
        if not choice or not choice.entry then return nil end
        local text, left_id, right_id = choice.entry.text:match("(.+)|(-?%d+) (-?%d+)$")
        return text, tonumber(left_id), tonumber(right_id)
    end
    for index, clause in ipairs(state.clauses) do
        local prev, next_clause = state.clauses[index - 1], state.clauses[index + 1]
        local _, _, prev_right = ids(prev and prev.candidates[prev.selected])
        local _, next_left = ids(next_clause and next_clause.candidates[next_clause.selected])
        local scores, best_by_text = {}, {}
        for _, row in ipairs(dictionary) do
            if row.surface == clause.reading then
                local left_cost, right_cost
                if not prev then
                    local bos, prefix = matrix["0 " .. row.left_id], matrix["-10 " .. row.left_id]
                    if bos and prefix then left_cost = bos + prefix end
                elseif prev_right then left_cost = matrix[prev_right .. " " .. row.left_id] end
                if not next_clause then
                    local eos, suffix = matrix[row.right_id .. " 0"], matrix[row.right_id .. " -20"]
                    if eos and suffix then right_cost = eos + suffix end
                elseif next_left then right_cost = matrix[row.right_id .. " " .. next_left] end
                if left_cost and right_cost then
                    local score = row.cost + left_cost + right_cost
                    local key = row.candidate .. "|" .. row.left_id .. " " .. row.right_id
                    scores[key] = math.min(scores[key] or math.huge, score)
                    best_by_text[row.candidate] = math.min(best_by_text[row.candidate] or math.huge, score)
                end
            end
        end
        local ordered, representatives, unscored_seen = true, true, false
        local previous_score = -math.huge
        for _, choice in ipairs(clause.candidates) do
            local source = ids(choice)
            local score = choice.entry and scores[choice.entry.text]
            if score then
                if unscored_seen or score < previous_score then ordered = false end
                if score ~= best_by_text[source] then representatives = false end
                previous_score = score
            else unscored_seen = true end
        end
        check(ordered, label .. ": filtered clause " .. index .. " follows independent final-context costs")
        check(representatives, label .. ": filtered clause " .. index .. " uses each source text's best id pair")
        if heads[index] then
            local selected = clause.candidates[clause.selected]
            local best = math.huge
            for _, score in pairs(best_by_text) do best = math.min(best, score) end
            check(clause.selected == 1 and scores[selected.entry and selected.entry.text] == best,
                label .. ": changed clause " .. index .. " selects the independent final-context minimum")
        end
    end
end

print("== 21. initial selection follows the discovered contextual head, not the beam seed")
do
    local dict, matrix = {}, {
        ["0 100"] = 0, ["-10 100"] = 0, ["100 0"] = 1000, ["100 -20"] = 0,
        ["0 200"] = 0, ["-10 200"] = 0, ["200 0"] = 0, ["200 -20"] = 0,
    }
    for index = 1, 50 do
        dict[#dict + 1] = { surface = "あ", candidate = "埋" .. index,
            left_id = 100, right_id = 100, cost = index }
    end
    dict[#dict + 1] = { surface = "あ", candidate = "勝", left_id = 200, right_id = 200, cost = 51 }
    local readings = { ["あ"] = { { text = "埋1", phrase = { text = "埋1|100 100", custom_code = "あ " } } } }
    local bunsetsu, context, viterbi = new_engine(dict, matrix, readings)
    viterbi:analyze("あ")
    check(viterbi:best_n()().candidate == "埋1", "the upstream beam seed is 埋1, not the contextual winner")
    bunsetsu.start(context, "あ")
    local state = bunsetsu.state(context)
    local clause = state.clauses[1]
    check(51 < 1 + 1000 and clause.candidates[1].text == "勝",
        "the discovered head agrees with independent own plus EOS costs")
    check(clause.selected == 1 and bunsetsu.display(context) == "勝",
        "initial selection, final filtered head and preview all follow the contextual winner")
    check_final_single_node_scores(state, dict, matrix, { true }, "beam initial")
    context:set_option("_kagiroi_hide_candidates", false)
    bunsetsu.render(context)
    bunsetsu.select(context, 1)
    check(clause.candidates[clause.selected].text == "埋1" and bunsetsu.display(context) == "埋1",
        "the next candidate is relative to the contextual head, not the old beam seed")
end

print("== 22. resizing settles outer filtered route ids before publishing the reshaped pair")
do
    local dict = {
        { surface = "あか", candidate = "赤", left_id = 101, right_id = 101, cost = 1 },
        { surface = "あか", candidate = "赤", left_id = 102, right_id = 102, cost = 1 },
        { surface = "とりさ", candidate = "元", left_id = 401, right_id = 401, cost = 1 },
        { surface = "かな", candidate = "鉛", left_id = 501, right_id = 501, cost = 1 },
        { surface = "とり", candidate = "左1", left_id = 201, right_id = 201, cost = 100 },
        { surface = "とり", candidate = "左2", left_id = 202, right_id = 202, cost = 100 },
        { surface = "さかな", candidate = "右", left_id = 301, right_id = 301, cost = 100 },
    }
    local matrix = {
        ["101 401"] = 0, ["102 401"] = 100, ["401 501"] = 0,
        ["201 301"] = 0, ["202 301"] = 0,
        ["101 201"] = 10, ["101 202"] = 20,
        ["102 201"] = 5, ["102 202"] = 0,
    }
    local readings = {}
    for _, row in ipairs(dict) do
        for _, prefix in ipairs({ "0 ", "-10 " }) do matrix[prefix .. row.left_id] = 0 end
        matrix[row.right_id .. " 0"], matrix[row.right_id .. " -20"] = 0, 0
        readings[row.surface] = readings[row.surface] or {}
        readings[row.surface][#readings[row.surface] + 1] = { text = row.candidate,
            phrase = { text = row.candidate .. "|" .. row.left_id .. " " .. row.right_id,
                custom_code = row.surface .. " " } }
    end
    readings["あか"][#readings["あか"] + 1] = { text = "未採点" }
    for _, filtered_outer in ipairs({ false, true }) do
        local expand = function(candidate)
            if candidate.text == "赤" then yield(ShadowCandidate(candidate, "simplified", "🔴", "")) end
        end
        local bunsetsu, context = new_engine(dict, matrix, readings, expand, function() return true end)
        bunsetsu.start(context, "あかとりさかな")
        local state = bunsetsu.state(context)
        check(#state.clauses == 3 and state.clauses[2].reading == "とりさ"
            and state.clauses[3].reading == "かな" and bunsetsu.display(context) == "赤元鉛",
            "the fixture begins with the independently optimal A1/O/E segmentation")
        if filtered_outer then
            context:set_option("_kagiroi_hide_candidates", false)
            bunsetsu.render(context)
            bunsetsu.select(context, 1)
            check(state.clauses[1].candidates[state.clauses[1].selected].text == "🔴",
                "the outer selection is a one-to-many filter addition before resize")
        end
        local outer_text = state.clauses[1].candidates[state.clauses[1].selected].text
        state.active = 2
        context:set_option("_kagiroi_hide_candidates", true)
        bunsetsu.resize(context, -1)
        local outer, left, right = state.clauses[1], state.clauses[2], state.clauses[3]
        check(left.reading == "とり" and right.reading == "さかな", "the requested boundary changes to あか | とり | さかな")
        local outer_choice = outer.candidates[outer.selected]
        local left_choice, right_choice = left.candidates[left.selected], right.candidates[right.selected]
        check(outer_choice.text == outer_text and outer_choice.entry.text == "赤|102 102",
            "the outer display is preserved while its representative changes from A1 to A2")
        check(100 + matrix["102 202"] < 100 + matrix["102 201"]
            and left.candidates[1].text == "左2" and left_choice.text == "左2" and left.selected == 1,
            "the final filtered left head and selection agree with the independent A2-context minimum")
        check(right.selected == 1 and right_choice.text == "右" and right.candidates[1].text == "右",
            "the final filtered right selection is the independent only-route contextual head")
        check(outer.candidates[#outer.candidates].text == "未採点",
            "the unscored outer candidate is retained after the scored sources and their filter additions")
        local has_emoji = false
        for _, choice in ipairs(outer.candidates) do if choice.text == "🔴" then has_emoji = true end end
        check(has_emoji, "the one-to-many filter addition survives every stabilization pass")
        check_final_single_node_scores(state, dict, matrix, { [2] = true, [3] = true }, "outer resize")
        local preview = bunsetsu.display(context)
        for _ = 1, 3 do bunsetsu.render(context) end
        check(bunsetsu.display(context) == preview and left.candidates[left.selected].text == "左2"
            and outer.candidates[outer.selected].entry.text == "赤|102 102",
            "repeated final publication does not change representative ids, selection or preview")
    end
end

print("== 23. selection, paging and menu sync settle filtered ids beyond the immediate neighbor")
do
    local dict = {
        { surface = "あ", candidate = "赤", left_id = 101, right_id = 101, cost = 1 },
        { surface = "あ", candidate = "赤", left_id = 102, right_id = 102, cost = 1 },
        { surface = "あ", candidate = "青", left_id = 103, right_id = 103, cost = 0 },
        { surface = "い", candidate = "同", left_id = 201, right_id = 201, cost = 100 },
        { surface = "い", candidate = "同", left_id = 202, right_id = 202, cost = 100 },
        { surface = "い", candidate = "同", left_id = 203, right_id = 203, cost = 100 },
    }
    local matrix = {
        ["101 201"] = 0, ["102 201"] = 20, ["103 201"] = 30,
        ["101 202"] = 10, ["102 202"] = 0, ["103 202"] = 0,
        ["101 203"] = 10, ["102 203"] = 0, ["103 203"] = 0,
    }
    for index = 1, 11 do
        local id = 300 + index
        dict[#dict + 1] = { surface = "う", candidate = "隣" .. index, left_id = id, right_id = id, cost = index }
        matrix["201 " .. id] = index == 11 and 100 or 0
        matrix["202 " .. id], matrix["203 " .. id] = index == 11 and 0 or 50, index == 11 and 0 or 50
    end
    local readings = {}
    for _, row in ipairs(dict) do
        matrix["0 " .. row.left_id], matrix["-10 " .. row.left_id] = 0, 0
        matrix[row.right_id .. " 0"], matrix[row.right_id .. " -20"] = 0, 0
        readings[row.surface] = readings[row.surface] or {}
        readings[row.surface][#readings[row.surface] + 1] = { text = row.candidate,
            phrase = { text = row.candidate .. "|" .. row.left_id .. " " .. row.right_id, custom_code = row.surface .. " " } }
    end
    readings["う"][#readings["う"] + 1] = { text = "未採点" }
    for _, operation in ipairs({ "select", "page", "sync" }) do
        local bunsetsu, context = new_engine(dict, matrix, readings, false, function() return true end)
        bunsetsu.start(context, "あいう")
        local state = bunsetsu.state(context)
        check(bunsetsu.display(context) == "赤同隣1", operation .. ": initial preview follows the independent minimum")
        state.active = 3
        context:set_option("_kagiroi_hide_candidates", false)
        bunsetsu.render(context)
        if operation == "select" then
            for _ = 1, 10 do bunsetsu.select(context, 1) end
        elseif operation == "page" then bunsetsu.page(context, 1)
        else
            context:set_option("_kagiroi_expand_candidates", true)
            bunsetsu.render(context)
            context:highlight(10)
            bunsetsu.display(context)
        end
        local outer, middle, active = state.clauses[1], state.clauses[2], state.clauses[3]
        check(active.candidates[active.selected].text == "隣11" and bunsetsu.display(context) == "赤同隣11",
            operation .. ": the user's chosen display and both other displays are preserved")
        check(middle.candidates[middle.selected].entry.text == "同|202 202"
            and outer.candidates[outer.selected].entry.text == "赤|102 102" and outer.candidates[1].text == "青",
            operation .. ": representative ids propagate two clauses while the outer selected 赤 is not its head 青")
        check_final_single_node_scores(state, dict, matrix, {}, operation .. " propagated")
        local unscored_index
        for index, choice in ipairs(active.candidates) do
            if choice.text == "未採点" then unscored_index = index break end
        end
        bunsetsu.select(context, unscored_index - active.selected)
        check(active.candidates[active.selected].text == "未採点" and bunsetsu.display(context) == "赤同未採点",
            operation .. ": choosing an unscored boundary retains the surrounding selections without a loop")
        local original_index
        for index, choice in ipairs(active.candidates) do
            if choice.text == "隣1" then original_index = index break end
        end
        bunsetsu.select(context, original_index - active.selected)
        check(active.candidates[active.selected].text == "隣1" and bunsetsu.display(context) == "赤同隣1"
            and middle.candidates[middle.selected].entry.text == "同|201 201"
            and outer.candidates[outer.selected].entry.text == "赤|101 101",
            operation .. ": returning from an unscored boundary restores the best source identities")
        check_final_single_node_scores(state, dict, matrix, {}, operation .. " restored")
    end
end

print(string.format("probe4: %d checks, %d failures", checks, failures))
os.exit(failures == 0 and 0 or 1)
