local test_dir = arg[0]:match("^(.*)/")
local bunsetsu_path = arg[1]
package.path = test_dir .. "/?.lua;" .. test_dir .. "/probe/fixed/?.lua;" .. test_dir .. "/probe/?.lua;"
    .. bunsetsu_path:match("^(.*)/kagiroi/") .. "/?.lua;" .. package.path

local synth = require("viterbi_synth_env")
synth.install_globals()
local viterbi_module = require("kagiroi/kagiroi_viterbi")

local rime_mocks = require("rime_mocks")
rime_mocks.install_globals()

local function new_engine(dictionary, matrix, readings, expand_emoji, boundary, userdict)
    local synth_env = synth.new_env(dictionary, userdict, matrix)
    local viterbi = viterbi_module.new(synth_env)
    package.loaded["kagiroi/segmenter"] = nil
    package.loaded["kagiroi/kagiroi_translator"] = nil
    package.loaded["kagiroi/char_variants"] = nil
    package.preload["kagiroi/kagiroi_translator"] = nil
    package.preload["kagiroi/segmenter"] = function()
        return { is_boundary_internal = function(right_id, left_id)
            if right_id == 0 or left_id == 0 then return true end
            if boundary then return boundary(right_id, left_id) end
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

local function record_learning(bunsetsu, context, userdict)
    context.translator_env.mem.update_userdict = function(_, entry)
        for _, row in ipairs(userdict) do
            if row.text == entry.text and row.surface == entry.custom_code:match("^(.*) $") then
                row.commit_count = row.commit_count + 1
                return
            end
        end
        userdict[#userdict + 1] = {
            surface = entry.custom_code:match("^(.*) $"),
            text = entry.text,
            commit_count = 1,
        }
    end
    bunsetsu.learn(context)
end

local function select_clause_text(bunsetsu, context, index, text)
    local state = bunsetsu.state(context)
    state.active = index
    bunsetsu.render(context)
    local clause = state.clauses[index]
    for position, choice in ipairs(clause.candidates) do
        if choice.text == text then
            bunsetsu.select(context, position - clause.selected)
            return true
        end
    end
    return false
end

local function pos_matrix(ids, overrides)
    local matrix = {}
    local lefts, rights = { 0, -20 }, { 0, -10 }
    for _, id in ipairs(ids) do
        lefts[#lefts + 1] = id
        rights[#rights + 1] = id
    end
    for _, right_id in ipairs(rights) do
        for _, left_id in ipairs(lefts) do
            matrix[right_id .. " " .. left_id] = 0
        end
    end
    for key, value in pairs(overrides or {}) do matrix[key] = value end
    return matrix
end

local function pos_engine(dictionary, matrix, userdict, boundary)
    local readings = {}
    for _, row in ipairs(dictionary) do
        readings[row.surface] = readings[row.surface] or {}
        readings[row.surface][#readings[row.surface] + 1] = { text = row.candidate,
            phrase = { text = row.candidate .. "|" .. row.left_id .. " " .. row.right_id,
                custom_code = row.surface .. " " } }
    end
    return new_engine(dictionary, matrix, readings, false, boundary, userdict)
end


local function selected_route(bunsetsu, context, index)
    local clause = bunsetsu.state(context).clauses[index or 1]
    return clause.candidates[clause.selected].route_words
end

local function history_count(histories, text)
    for _, history in ipairs(histories) do
        if history.text == text then return history.commit_count end
    end
    return 0
end

print("== 1. candidates include different parts of speech, inflections and word spans")
do
    local dictionary = {
        { surface = "いがい", candidate = "以外", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "いがい", candidate = "意外", left_id = 1841, right_id = 701, cost = 300 },
        { surface = "いがいと", candidate = "異該都", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "と", candidate = "と", left_id = 368, right_id = 368, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1841, 701, 368 })
    for _, reading in ipairs({ "いがい", "いがいと" }) do
        local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return false end)
        bunsetsu.start(context, reading)
        local expected = reading == "いがい" and "意外" or "意外と"
        check(select_clause_text(bunsetsu, context, 1, expected),
            "different POS, inflection and word count remain selectable for " .. reading)
        local words = selected_route(bunsetsu, context)
        check(words and words[1].left_id == 1841 and words[1].right_id == 701,
            "selection retains the actual route ids")
    end
end

print("== 2. identical text keeps the best full route and learns only its middle ids")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 2, right_id = 2, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 3, right_id = 3, cost = 500 },
        { surface = "う", candidate = "宇", left_id = 4, right_id = 4, cost = 100 },
    }
    local saved = "亜伊宇|1851 1851\tp2:c あ,亜,1,1;い,伊,3,3;う,宇,4,4"
    local histories = { { surface = "あいう", text = saved, commit_count = 8 } }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({1, 2, 3, 4}), histories,
        function() return false end)
    bunsetsu.start(context, "あいう")
    local clause, duplicates = bunsetsu.state(context).clauses[1], 0
    for _, choice in ipairs(clause.candidates) do if choice.text == "亜伊宇" then duplicates = duplicates + 1 end end
    check(duplicates == 1 and selected_route(bunsetsu, context)[2].left_id == 3,
        "one displayed text uses the learned middle POS rather than only matching endpoints")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, saved) == 9 and #histories == 2,
        "only the selected complete route and independent boundary history are incremented")
end

print("== 3. one-word and multiword histories remain separate and change automatic segmentation")
do
    local dictionary = {
        { surface = "あい", candidate = "亜伊", left_id = 1, right_id = 2, cost = 100 },
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 200 },
        { surface = "い", candidate = "伊", left_id = 2, right_id = 2, cost = 200 },
    }
    local single = "亜伊|1851 1851\tp2:c あい,亜伊,1,2"
    local multi = "亜伊|1851 1851\tp2:c あ,亜,1,1;い,伊,2,2"
    local histories = {}
    local matrix = pos_matrix({1, 2})
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return true end)
    bunsetsu.start(context, "あい")
    check(#bunsetsu.state(context).clauses == 1 and #selected_route(bunsetsu, context) == 1,
        "dictionary costs initially prefer a single word")
    record_learning(bunsetsu, context, histories)
    histories[#histories + 1] = { surface = "あい", text = multi, commit_count = 64 }
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return true end)
    bunsetsu.start(context, "あい")
    check(#selected_route(bunsetsu, context) == 2 and bunsetsu.display(context) == "亜伊",
        "multiword history defeats the original one-word analysis without losing the saved boundary")
    histories[#histories + 1] = { surface = "あい", text = "あい|1851 1851\tb1 1,1", commit_count = 64 }
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return true end)
    bunsetsu.start(context, "あい")
    check(#bunsetsu.state(context).clauses == 2,
        "the more frequent split boundary competes with the old single-clause boundary")
    bunsetsu.resize(context, 1)
    check(#bunsetsu.state(context).clauses == 1 and #selected_route(bunsetsu, context) == 2,
        "manual boundaries remain fixed while candidate ranking uses the multiword history")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, single) == 1 and history_count(histories, multi) == 65,
        "selecting the multiword route does not merge its count into the single-word route")
end

print("== 4. repeated commits promote changed words, parts of speech and boundaries")
do
    local dictionary = {
        { surface = "あい", candidate = "愛", left_id = 1, right_id = 1, cost = 100 },
        { surface = "あ", candidate = "亜", left_id = 2, right_id = 2, cost = 30000 },
        { surface = "い", candidate = "伊", left_id = 3, right_id = 3, cost = 30000 },
    }
    local histories, matrix = {}, pos_matrix({1, 2, 3})
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あい")
    check(bunsetsu.display(context) == "愛", "unlearned dictionary costs lead initially")
    for round = 1, 16 do
        bunsetsu.start(context, "あい")
        if #bunsetsu.state(context).clauses == 1 then bunsetsu.resize(context, -1) end
        check(select_clause_text(bunsetsu, context, 1, "亜") and select_clause_text(bunsetsu, context, 2, "伊"),
            "both changed-POS dictionary words can be chosen in round " .. round)
        record_learning(bunsetsu, context, histories)
        if round == 1 then
            bunsetsu.start(context, "あい")
            check(bunsetsu.display(context) == "愛", "one commit need not replace the dictionary analysis")
        end
    end
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あい")
    local clauses = bunsetsu.state(context).clauses
    check(#clauses == 2 and clauses[1].reading == "あ" and bunsetsu.display(context) == "亜伊",
        "a new engine restores the learned route, two clauses and their first candidates")
end

print("== 5. the same lexical route keeps distinct boundary histories")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 2, right_id = 2, cost = 100 },
    }
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({1, 2}), histories, function() return false end)
    bunsetsu.start(context, "あい")
    record_learning(bunsetsu, context, histories)
    bunsetsu.resize(context, -1)
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, "あい|1851 1851\tb1 2") == 1
        and history_count(histories, "あい|1851 1851\tb1 1,1") == 1,
        "identical reading, text and word route do not combine different boundary counts")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, "あい|1851 1851\tb1 2") == 1
        and history_count(histories, "あい|1851 1851\tb1 1,1") == 2,
        "committing one boundary pattern increments only that boundary pattern")
end

print("== 6. non-dictionary clauses learn boundaries without new vocabulary")
do
    local histories = {}
    local matrix = pos_matrix({1})
    local bunsetsu, context = pos_engine({}, matrix, histories, function() return false end)
    for _ = 1, 4 do
        bunsetsu.start(context, "abcd")
        if #bunsetsu.state(context).clauses == 1 then bunsetsu.resize(context, -1) end
        record_learning(bunsetsu, context, histories)
    end
    check(#histories == 1 and history_count(histories, "abcd|1851 1851\tb1 3,1") == 4,
        "only the boundary record is saved for raw alphabetic clauses")
    bunsetsu, context = pos_engine({}, matrix, histories, function() return false end)
    bunsetsu.start(context, "abcd")
    local clauses = bunsetsu.state(context).clauses
    check(#clauses == 2 and clauses[1].reading == "abc" and clauses[2].reading == "d",
        "non-dictionary boundary history survives a fresh engine")
    bunsetsu.start(context, "abcde")
    check(#bunsetsu.state(context).clauses == 1, "boundary history is not generalized to a different full reading")
end

print("== 7. partial multiword histories affect both analysis and candidate rank")
do
    local dictionary = {
        { surface = "あい", candidate = "愛", left_id = 1, right_id = 1, cost = 100 },
        { surface = "あ", candidate = "亜", left_id = 2, right_id = 2, cost = 300 },
        { surface = "い", candidate = "伊", left_id = 3, right_id = 3, cost = 300 },
        { surface = "う", candidate = "宇", left_id = 4, right_id = 4, cost = 100 },
    }
    for _, suffix in ipairs({ "", "|1851 1851", "|1851 1851\tp2:c あ,亜,2,2;い,伊,3,3" }) do
        local histories = { { surface = "あい", text = "亜伊" .. suffix, commit_count = 8 } }
        local bunsetsu, context = pos_engine(dictionary, pos_matrix({1, 2, 3, 4}), histories,
            function() return false end)
        bunsetsu.start(context, "あいう")
        check(bunsetsu.display(context) == "亜伊宇" and #selected_route(bunsetsu, context) == 3,
            "typed and legacy multiword histories work inside a longer reading")
        record_learning(bunsetsu, context, histories)
        check(histories[1].commit_count == 8 and histories[1].text == "亜伊" .. suffix,
            "learning a longer reading preserves the old partial record without inferred ids or boundaries")
    end
end

print("== 8. a finite learning score can lose to a different connection context")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 100 },
        { surface = "あ", candidate = "阿", left_id = 2, right_id = 2, cost = 300 },
        { surface = "い", candidate = "伊", left_id = 3, right_id = 3, cost = 100 },
    }
    local histories = { { surface = "あ", text = "阿|1851 1851\tp2:c あ,阿,2,2", commit_count = 8 } }
    local matrix = pos_matrix({1, 2, 3}, { ["2 3"] = 100000 })
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return true end)
    bunsetsu.start(context, "あ")
    check(bunsetsu.display(context) == "阿", "saved history promotes the learned word in isolation")
    bunsetsu.start(context, "あい")
    check(bunsetsu.display(context) == "亜伊", "connection costs can defeat a learned route in another context")
    check(select_clause_text(bunsetsu, context, 1, "阿"), "the lower-ranked learned route remains selectable")
end

print("== 9. different POS routes with the same surface stay independently learned")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 100 },
        { surface = "あ", candidate = "亜", left_id = 2, right_id = 2, cost = 300 },
    }
    local histories = { { surface = "あ", text = "亜|1851 1851\tp2:c あ,亜,2,2", commit_count = 8 } }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({1, 2}), histories, function() return false end)
    bunsetsu.start(context, "あ")
    check(#bunsetsu.state(context).clauses[1].candidates == 1 and selected_route(bunsetsu, context)[1].left_id == 2,
        "text deduplication retains the best scored POS route")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, "亜|1851 1851\tp2:c あ,亜,2,2") == 9
        and history_count(histories, "亜|1851 1851\tp2:c あ,亜,1,1") == 0,
        "only the selected POS route is incremented")
end

print("== 10. legacy records remain separate when new typed and boundary histories are saved")
do
    local dictionary = { { surface = "あ", candidate = "あ", left_id = 1, right_id = 1, cost = 100 } }
    for _, old in ipairs({ "あ", "あ|1851 1851", "あ|1851 1851\tp2:c", "あ|1851 1851\tp2:s" }) do
        local histories = { { surface = "あ", text = old, commit_count = 8 } }
        local bunsetsu, context = pos_engine(dictionary, pos_matrix({1}), histories, function() return false end)
        bunsetsu.start(context, "あ")
        record_learning(bunsetsu, context, histories)
        check(history_count(histories, old) == 8 and #histories == 3,
            "legacy kana entries keep their original ids, scope and count")
        check(history_count(histories, "あ|1851 1851\tp2:c あ,あ,1,1") == 1
            and history_count(histories, "あ|1851 1851\tb1 1") == 1,
            "new route and boundary records do not inherit the legacy commit count")
    end
end

print("== 11. katakana overrides do not add vocabulary")
do
    local dictionary = { { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 100 } }
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({1}), histories, function() return false end)
    bunsetsu.start(context, "あ", "ア")
    record_learning(bunsetsu, context, histories)
    check(#histories == 1 and history_count(histories, "あ|1851 1851\tb1 1") == 1,
        "katakana conversion records only its reading boundary")
end

print("== 12. equal costs prefer shorter initial word spans and dictionary order")
do
    local dictionary = {
        { surface = "あい", candidate = "愛", left_id = 1, right_id = 1, cost = 200 },
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 100 },
        { surface = "あ", candidate = "阿", left_id = 1, right_id = 1, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1, right_id = 1, cost = 100 },
    }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({1}), {}, function() return true end)
    bunsetsu.start(context, "あい")
    check(#bunsetsu.state(context).clauses == 2 and bunsetsu.display(context) == "亜伊",
        "equal automatic paths choose shorter words first, then dictionary order")
end

print("== 12a. initial analysis compares suffix boundaries before the first dictionary choice")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 0 },
        { surface = "あ", candidate = "阿", left_id = 2, right_id = 2, cost = 0 },
        { surface = "あ", candidate = "唖", left_id = 2, right_id = 2, cost = 0 },
        { surface = "いう", candidate = "言う", left_id = 3, right_id = 3, cost = 0 },
        { surface = "い", candidate = "伊", left_id = 4, right_id = 4, cost = 0 },
        { surface = "う", candidate = "宇", left_id = 5, right_id = 5, cost = 0 },
    }
    local matrix = pos_matrix({1, 2, 3, 4, 5}, { ["1 4"] = 100, ["2 3"] = 100 })
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return true end)
    bunsetsu.start(context, "あいう")
    check(#bunsetsu.state(context).clauses == 3 and bunsetsu.display(context) == "阿伊宇",
        "initial segmentation prefers all shorter boundaries, then dictionary order among tied readings")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, "阿伊宇|1851 1851\tp2:s あ,阿,2,2;い,伊,4,4;う,宇,5,5") == 1,
        "confirmation learns the initially selected shorter route and its actual POS ids")
end

print("== 13. lattice-backed engines still analyze the reading before splitting")
do
    local dictionary = {
        { surface = "あい", candidate = "愛", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1841, right_id = 1841, cost = 100 },
    }
    local bunsetsu, context, viterbi = pos_engine(dictionary, pos_matrix({1851, 1841}), {}, function() return true end)
    local analyze, lookup = viterbi.analyze, viterbi._lookup
    viterbi._lookup = false
    function viterbi:analyze(reading)
        self._lookup = lookup
        analyze(self, reading)
        self._lookup = false
    end
    bunsetsu.start(context, "あいう")
    check(#bunsetsu.state(context).clauses == 2 and bunsetsu.display(context) == "愛宇",
        "lattice-backed fallback retains dictionary choices without a lookup API")
end

print("== 14. sentence history keeps its learned route when clause candidates are reranked")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 2, right_id = 2, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 3, right_id = 3, cost = 500 },
        { surface = "う", candidate = "宇", left_id = 4, right_id = 4, cost = 100 },
        { surface = "え", candidate = "絵", left_id = 5, right_id = 5, cost = 100 },
    }
    local saved = "亜伊宇絵|1851 1851\tp2:s あ,亜,1,1;い,伊,3,3;う,宇,4,4;え,絵,5,5"
    local histories = { { surface = "あいうえ", text = saved, commit_count = 8 } }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({1, 2, 3, 4, 5}), histories,
        function(right_id) return right_id == 4 end)
    bunsetsu.start(context, "あいうえ")
    check(#bunsetsu.state(context).clauses == 2 and selected_route(bunsetsu, context)[2].left_id == 3,
        "full-sentence history retains its middle POS across a clause boundary")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, saved) == 9,
        "confirmation increments the full-sentence route that actually won analysis")
end

print("== 15. mixed raw and dictionary boundaries do not create invented vocabulary routes")
do
    local dictionary = { { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 100 } }
    local histories = { { surface = "あq", text = "あq|1851 1851\tb1 2", commit_count = 8 } }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({1}), histories, function() return true end)
    bunsetsu.start(context, "あq")
    check(#bunsetsu.state(context).clauses == 1, "saved boundaries may join dictionary and raw spans")
    record_learning(bunsetsu, context, histories)
    check(#histories == 1, "a mixed fallback clause records no invented full-reading dictionary route")
end

print("== 16. partial histories retain internal POS routes across resized clause boundaries")
do
    for _, variant_index in ipairs({ 2, 4 }) do
        local dictionary, surfaces, texts = {}, { "あ", "い", "う", "え", "お" }, { "亜", "伊", "宇", "絵", "尾" }
        for index, surface in ipairs(surfaces) do
            dictionary[#dictionary + 1] = { surface = surface, candidate = texts[index],
                left_id = index, right_id = index, cost = 100 }
        end
        dictionary[#dictionary + 1] = { surface = surfaces[variant_index], candidate = texts[variant_index],
            left_id = 6, right_id = 6, cost = 500 }
        for _, span in ipairs({ {1, 2}, {1, 3}, {3, 5}, {4, 5} }) do
            dictionary[#dictionary + 1] = { surface = table.concat(surfaces, "", span[1], span[2]),
                candidate = table.concat(texts, "", span[1], span[2]),
                left_id = span[1], right_id = span[2], cost = 99999 }
        end
        local encoded = {}
        for index = 2, 4 do
            local id = index == variant_index and 6 or index
            encoded[#encoded + 1] = surfaces[index] .. "," .. texts[index] .. "," .. id .. "," .. id
        end
        local saved = "伊宇絵|1851 1851\tp2:c " .. table.concat(encoded, ";")
        local histories = { { surface = "いうえ", text = saved, commit_count = 8 } }
        local bunsetsu, context = pos_engine(dictionary, pos_matrix({1, 2, 3, 4, 5, 6}), histories,
            function() return false end)
        bunsetsu.start(context, "あいうえお")
        check(selected_route(bunsetsu, context)[variant_index].left_id == 6,
            "partial history initially selects its learned internal POS")
        local shifts = variant_index == 2 and 2 or 3
        for _ = 1, shifts do bunsetsu.resize(context, -1) end
        local clause_index, word_index = variant_index == 2 and 1 or 2, 2
        local state = bunsetsu.state(context)
        check(state.clauses[1].reading == (variant_index == 2 and "あいう" or "あい")
            and state.clauses[2].reading == (variant_index == 2 and "えお" or "うえお"),
            "manual boundaries remain unchanged when history crosses both clause edges")
        local clause, learned_route, ordinary_route = state.clauses[clause_index], false, false
        for _, choice in ipairs(clause.unfiltered) do
            local word = choice.route_words and choice.route_words[word_index]
            if word and word.left_id == 6 then learned_route = true end
            if word and word.left_id == variant_index then ordinary_route = true end
        end
        check(learned_route and ordinary_route,
            "matching endpoint ids do not discard either internal route before history evaluation")
        check(selected_route(bunsetsu, context, clause_index)[word_index].left_id == 6,
            "cross-boundary partial history selects its learned internal POS on either side")
        local displayed = {}
        for _, choice in ipairs(clause.candidates) do
            check(not displayed[choice.text], "internal route alternatives do not duplicate displayed text")
            displayed[choice.text] = true
        end
        record_learning(bunsetsu, context, histories)
        check(history_count(histories, saved) == 8,
            "committing resized clauses preserves the original partial history count")
        local retained = false
        for _, history in ipairs(histories) do
            if history.surface == clause.reading and history.text:find(",6,6", 1, true) then retained = true end
        end
        check(retained, "confirmation saves the internal route selected after boundary changes")
    end
end

print("== 17. duplicate prefix texts retain the route with the best initial connection")
do
    local dictionary, ids = {}, {}
    for id = 1, 24 do
        ids[#ids + 1] = id
        for index, surface in ipairs({ "あ", "い", "う" }) do
            dictionary[#dictionary + 1] = { surface = surface, candidate = ({ "亜", "伊", "宇" })[index],
                left_id = id, right_id = id, cost = 100 }
        end
    end
    local matrix = pos_matrix(ids, { ["0 24"] = -1000 })
    local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return false end)
    bunsetsu.start(context, "あいう")
    local clause = bunsetsu.state(context).clauses[1]
    check(#clause.candidates == 1 and bunsetsu.display(context) == "亜伊宇",
        "many equivalent POS prefixes still produce one displayed candidate")
    check(selected_route(bunsetsu, context)[1].left_id == 24,
        "prefix deduplication compares initial connection and lexical costs together")
end

print("== 18. initial clauses retain simultaneous internal POS changes from a sentence history")
do
    local surfaces, texts = { "あ", "い", "う", "え", "お", "か" }, { "亜", "伊", "宇", "絵", "尾", "蚊" }
    local dictionary = {}
    for index, surface in ipairs(surfaces) do
        dictionary[#dictionary + 1] = { surface = surface, candidate = texts[index],
            left_id = index, right_id = index, cost = 100 }
    end
    dictionary[#dictionary + 1] = { surface = "い", candidate = "伊", left_id = 7, right_id = 7, cost = 500 }
    dictionary[#dictionary + 1] = { surface = "お", candidate = "尾", left_id = 8, right_id = 8, cost = 500 }
    local saved = "亜伊宇絵尾蚊|1851 1851\tp2:s あ,亜,1,1;い,伊,7,7;う,宇,3,3;え,絵,4,4;お,尾,8,8;か,蚊,6,6"
    local histories = { { surface = "あいうえおか", text = saved, commit_count = 8 } }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({1, 2, 3, 4, 5, 6, 7, 8}), histories,
        function(right_id) return right_id == 3 end)
    bunsetsu.start(context, "あいうえおか")
    local clauses = bunsetsu.state(context).clauses
    check(#clauses == 2 and clauses[1].reading == "あいう" and clauses[2].reading == "えおか",
        "sentence analysis preserves the two expected clause boundaries")
    check(selected_route(bunsetsu, context, 1)[2].left_id == 7
        and selected_route(bunsetsu, context, 2)[2].left_id == 8,
        "both clauses initially select the complete learned routes, not just matching endpoint ids")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, saved) == 9,
        "confirmation increments the original sentence history without replacing either internal POS")
end

print("== 19. deep same-frame stock candidates follow the complete contextual order")
do
    local dictionary, readings = {}, { ["あ"] = {}, ["う"] = {} }
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1851 695"] = 10000, ["1898 695"] = 0,
    })
    for index = 1, 65 do
        local text = "候" .. index
        local id = index == 65 and 1898 or 1851
        dictionary[#dictionary + 1] = { surface = "あ", candidate = text, left_id = id, right_id = id, cost = index }
        readings["あ"][index] = { text = text, phrase = { text = text .. "|" .. id .. " " .. id, custom_code = "あ " } }
    end
    for index, id in ipairs({ 694, 695 }) do
        local text = "隣" .. index
        dictionary[#dictionary + 1] = { surface = "う", candidate = text, left_id = id, right_id = id, cost = index * 100000 }
        readings["う"][index] = { text = text, phrase = { text = text .. "|" .. id .. " " .. id, custom_code = "う " } }
    end
    local bunsetsu, context, viterbi = new_engine(dictionary, matrix, readings, false, function() return true end)
    bunsetsu.start(context, "あう")
    local state = bunsetsu.state(context)
    local clause = state.clauses[1]
    check(#clause.candidates == 65 and bunsetsu.display(context) == "候1隣1",
        "all sixty-five stock texts remain available beyond the upstream beam")
    for index, choice in ipairs(clause.candidates) do
        check(choice.text == "候" .. index, "the complete initial menu follows independent word costs at rank " .. index)
    end
    viterbi:analyze("あ")
    local isolated_target_rank = 0
    for assembly in viterbi:best_n() do
        isolated_target_rank = isolated_target_rank + 1
        check(assembly.candidate ~= "候65", "the contextual target is outside the isolated beam")
    end
    check(isolated_target_rank > 30, "the isolated premise extends beyond the first thirty candidates")
    check(select_clause_text(bunsetsu, context, 2, "隣2"), "the alternate neighbor remains in the same verb form")
    check(clause.candidates[1].text == "候65" and bunsetsu.display(context) == "候1隣2",
        "context promotes the deepest text while preserving the neighboring selected display")
    for index = 2, #clause.candidates do
        check(clause.candidates[index].text == "候" .. (index - 1),
            "every remaining page follows its independent contextual cost at rank " .. index)
    end
    matrix["1851 0"] = 10000
    bunsetsu, context, viterbi = new_engine(dictionary, matrix, { ["あ"] = { readings["あ"][1] } })
    viterbi:analyze("あ")
    check(viterbi:best_n()().candidate ~= "候65", "the stock beam does not supply the contextual first")
    bunsetsu.start(context, "あ")
    check(bunsetsu.display(context) == "候65" and bunsetsu.state(context).clauses[1].selected == 1,
        "initial selection and preview use the discovered contextual head rather than the beam seed")
end

print("== 20. full-cover stock texts survive a prefix stream longer than five hundred twelve rows")
do
    local dictionary = {}
    local matrix = pos_matrix({ 368 })
    for index = 1, 49 do
        dictionary[index] = { surface = "あ", candidate = utf8.char(0x4e00 + index),
            left_id = 368, right_id = 368, cost = 100 + index }
    end
    local reading = string.rep("あ", 14)
    local stock_texts, prefix_count, last_full_position = {}, 0, 0
    local readings = { [reading] = function(seg, env)
        for assembly in env.viterbi:best_n_prefix() do
            prefix_count = prefix_count + 1
            if assembly.surface == reading then
                stock_texts[assembly.candidate] = true
                last_full_position = prefix_count
                local candidate = Candidate("kagiroi", seg.start, seg._end, assembly.candidate, "")
                candidate.phrase = { text = assembly.candidate .. "|368 368", custom_code = reading .. " " }
                yield(candidate)
            end
        end
    end }
    local bunsetsu, context = new_engine(dictionary, matrix, readings)
    bunsetsu.start(context, reading)
    local clause = bunsetsu.state(context).clauses[1]
    check(prefix_count > 512 and last_full_position > 512, "the fixture supplies full-cover stock texts after row 512")
    local displayed = {}
    for _, choice in ipairs(clause.candidates) do displayed[choice.text] = true end
    for text in pairs(stock_texts) do
        local expected_cost = 0
        for _, codepoint in utf8.codes(text) do expected_cost = expected_cost + 100 + codepoint - 0x4e00 end
        local scored = false
        for _, choice in ipairs(clause.unfiltered) do
            if choice.text == text and choice.own == expected_cost then scored = true end
        end
        check(displayed[text] and scored, "each full-cover stock text retains its independent route cost: " .. text)
    end
end

print("== 21. tied paths retain the selected text and ranked alternatives within bounded work")
do
    local dictionary = {}
    for index = 1, 48 do
        dictionary[index] = { surface = "あ", candidate = utf8.char(0x4e00 + index),
            left_id = 368, right_id = 368, cost = 0 }
    end
    local reading = string.rep("あ", 12)
    local bunsetsu, context, viterbi = new_engine(dictionary, pos_matrix({ 368 }), {})
    viterbi:analyze(reading)
    local initial_text = viterbi:best_n()().candidate
    local instruction_budget, hook_interval = 20000000, 10000
    local instructions = 0
    debug.sethook(function()
        instructions = instructions + hook_interval
        if instructions > instruction_budget then error("equal-cost search exceeded 20 million instructions") end
    end, "", hook_interval)
    local completed, problem = pcall(bunsetsu.start, context, reading)
    debug.sethook()
    assert(completed, problem)
    local clause = bunsetsu.state(context).clauses[1]
    local seen, initial_scored = {}, false
    for _, choice in ipairs(clause.unfiltered) do
        if choice.text == initial_text and choice.own == 0 then initial_scored = true end
    end
    check(initial_scored and #clause.candidates == 31, "the selected tied route and thirty discovered texts remain available")
    check(clause.candidates[clause.selected].text == initial_text, "discovery preserves the initially selected text")
    for index = 1, 31 do
        local expected = string.rep(utf8.char(0x4e01), 11) .. utf8.char(0x4e00 + index)
        check(clause.candidates[index].text == expected, "equal-cost dictionary order is stable at rank " .. index)
    end
    for _, choice in ipairs(clause.candidates) do
        check(not seen[choice.text], "tied paths display each text only once")
        seen[choice.text] = true
    end
end

print("== 21a. equal-cost discovery compares all word boundaries before dictionary choices")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1, right_id = 1, cost = 0 },
        { surface = "あ", candidate = "阿", left_id = 1, right_id = 1, cost = 0 },
        { surface = "いう", candidate = "言う", left_id = 1, right_id = 1, cost = 0 },
        { surface = "い", candidate = "伊", left_id = 1, right_id = 1, cost = 0 },
        { surface = "う", candidate = "宇", left_id = 1, right_id = 1, cost = 0 },
    }
    local bunsetsu, context = new_engine(dictionary, pos_matrix({1}), {}, false,
        function() return false end)
    bunsetsu.start(context, "あいう")
    local candidates = bunsetsu.state(context).clauses[1].candidates
    for index, expected in ipairs({ "亜伊宇", "阿伊宇", "亜言う", "阿言う" }) do
        check(candidates[index] and candidates[index].text == expected,
            "shorter suffix boundaries precede dictionary choice at rank " .. index)
    end
end

print("== 22. contextual discovery includes an expensive prefix followed by a negative connection")
do
    local dictionary = {
        { surface = "あ", candidate = "遅", left_id = 1898, right_id = 1898, cost = 10000 },
        { surface = "い", candidate = "平", left_id = 1851, right_id = 1851, cost = 1 },
        { surface = "い", candidate = "勝", left_id = 1898, right_id = 1898, cost = 10 },
        { surface = "う", candidate = "隣1", left_id = 694, right_id = 694, cost = 1 },
        { surface = "う", candidate = "隣2", left_id = 695, right_id = 695, cost = 200000 },
    }
    for index = 1, 40 do
        dictionary[#dictionary + 1] = { surface = "あ", candidate = "安" .. index,
            left_id = 1851, right_id = 1851, cost = 100 + index }
    end
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1898 1898"] = -20000, ["1898 694"] = 100000,
    })
    local readings = {
        ["あい"] = { { text = "あい" } },
        ["う"] = {
            { text = "隣1", phrase = { text = "隣1|694 694", custom_code = "う " } },
            { text = "隣2", phrase = { text = "隣2|695 695", custom_code = "う " } },
        },
    }
    local bunsetsu, context = new_engine(dictionary, matrix, readings, false,
        function(_, left_id) return left_id == 694 or left_id == 695 end)
    bunsetsu.start(context, "あいう")
    local clause = bunsetsu.state(context).clauses[1]
    local previously_present = false
    for _, choice in ipairs(clause.candidates) do if choice.text == "遅勝" then previously_present = true end end
    check(not previously_present, "the negative-tail target is absent from the initial stock and contextual head")
    check(select_clause_text(bunsetsu, context, 2, "隣2"), "the new neighbor exposes the negative-tail context")
    check(clause.candidates[1].text == "遅勝", "the independent cost of minus 9990 wins within the fixed two-word frame")
    local scored = false
    for _, choice in ipairs(clause.unfiltered) do
        if choice.text == "遅勝" and choice.own == 10000 - 20000 + 10 then scored = true end
    end
    check(scored, "discovery retains the complete negative-tail route rather than pruning its expensive prefix")
end

print("== 23. selection paging and menu sync propagate same-text route identities without changing other displays")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 1 },
        { surface = "あ", candidate = "赤", left_id = 1898, right_id = 1898, cost = 1 },
        { surface = "い", candidate = "同", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "同", left_id = 695, right_id = 695, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1851 694"] = 0, ["1898 694"] = 20, ["1851 695"] = 10, ["1898 695"] = 0,
        ["694 1851"] = 0, ["694 1898"] = 100, ["695 1851"] = 50, ["695 1898"] = 0,
    })
    for index = 1, 40 do
        dictionary[#dictionary + 1] = { surface = "あ", candidate = "埋" .. index,
            left_id = 1851, right_id = 1851, cost = 2 }
    end
    local readings = { ["う"] = {} }
    for index = 1, 11 do
        local id = index == 11 and 1898 or 1851
        dictionary[#dictionary + 1] = { surface = "う", candidate = "隣" .. index,
            left_id = id, right_id = id, cost = index }
        readings["う"][index] = { text = "隣" .. index,
            phrase = { text = "隣" .. index .. "|" .. id .. " " .. id, custom_code = "う " } }
    end
    readings["う"][12] = { text = "未採点" }
    for _, operation in ipairs({ "select", "page", "sync" }) do
        local bunsetsu, context = new_engine(dictionary, matrix, readings, false, function() return true end)
        bunsetsu.start(context, "あいう")
        local state = bunsetsu.state(context)
        check(bunsetsu.display(context) == "赤同隣1", operation .. ": initial selections follow independent connection costs")
        local red_count, red_routes = 0, 0
        for _, choice in ipairs(state.clauses[1].candidates) do
            if choice.text == "赤" then red_count = red_count + 1 end
        end
        for _, choice in ipairs(state.clauses[1].unfiltered) do
            if choice.text == "赤" and choice.own ~= nil then red_routes = red_routes + 1 end
        end
        check(red_count == 1 and red_routes == 2 and #state.clauses[2].candidates == 1,
            operation .. ": a same-text route behind forty cheaper texts remains scored without duplicating its display")
        state.active = 3
        context:set_option("_kagiroi_hide_candidates", false)
        bunsetsu.render(context)
        if operation == "select" then
            for _ = 1, 10 do bunsetsu.select(context, 1) end
        elseif operation == "page" then
            bunsetsu.page(context, 1)
        else
            context:set_option("_kagiroi_expand_candidates", true)
            bunsetsu.render(context)
            context:highlight(10)
            bunsetsu.display(context)
        end
        local outer, middle = state.clauses[1], state.clauses[2]
        check(bunsetsu.display(context) == "赤同隣11"
            and outer.candidates[outer.selected].left_id == 1898
            and middle.candidates[middle.selected].left_id == 695,
            operation .. ": the best compatible representatives propagate across two unchanged displays")
        check(select_clause_text(bunsetsu, context, 3, "未採点") and bunsetsu.display(context) == "赤同未採点",
            operation .. ": an unscored boundary retains both surrounding displays")
        check(select_clause_text(bunsetsu, context, 3, "隣1") and bunsetsu.display(context) == "赤同隣1"
            and outer.candidates[outer.selected].left_id == 1851
            and middle.candidates[middle.selected].left_id == 694,
            operation .. ": returning to the original neighbor restores both best representatives")
    end
end

print("== 24. reranking preserves filtered choices unscored order and the target reading")
do
    local dictionary = {
        { surface = "あか", candidate = "赤", left_id = 1851, right_id = 1851, cost = 10 },
        { surface = "あか", candidate = "赤", left_id = 1898, right_id = 1898, cost = 15 },
        { surface = "あか", candidate = "朱", left_id = 1851, right_id = 1851, cost = 20 },
        { surface = "とり", candidate = "鳥", left_id = 1851, right_id = 1851, cost = 10 },
        { surface = "とり", candidate = "鶏", left_id = 1851, right_id = 1851, cost = 20 },
        { surface = "赤鳥", candidate = "誤表記", left_id = 1851, right_id = 1851, cost = 1 },
    }
    local readings = {
        ["あか"] = {
            { text = "赤", phrase = { text = "赤|1851 1841", custom_code = "あか " } },
            { text = "朱", phrase = { text = "朱|1851 1851", custom_code = "あか " } },
            { text = "よみ1" },
            { text = "幻", phrase = { text = "幻|999 999", custom_code = "あか " } },
            { text = "よみ2" }, { text = "アカ" },
        },
        ["とり"] = {
            { text = "鳥", phrase = { text = "鳥|1851 1851", custom_code = "とり " } },
            { text = "鶏", phrase = { text = "鶏|1851 1851", custom_code = "とり " } },
        },
    }
    for _, foreign in ipairs({ "とり", "赤鳥" }) do
        for _, selected_text in ipairs({ "朱", "よみ1", "🔴" }) do
            local bunsetsu, context, viterbi = new_engine(dictionary, pos_matrix({ 1851, 1898 }), readings, true,
                function() return true end)
            bunsetsu.start(context, "あかとり")
            local clause = bunsetsu.state(context).clauses[1]
            local displayed = {}
            for _, choice in ipairs(clause.candidates) do displayed[#displayed + 1] = choice.text end
            check(table.concat(displayed, "|") == "赤|朱|🔴|よみ1|よみ2|アカ",
                "real routes rank their texts while invalid phrase rows disappear and unscored rows keep their order")
            check(select_clause_text(bunsetsu, context, 1, selected_text), "the requested filtered choice is selectable: " .. selected_text)
            viterbi:analyze(foreign)
            check(select_clause_text(bunsetsu, context, 2, "鶏"), "neighbor selection reranks after foreign analysis: " .. foreign)
            bunsetsu.page(context, 1)
            check(clause.candidates[clause.selected].text == selected_text,
                "neighbor selection and paging retain the filtered text rather than a raw-route index: " .. selected_text)
            for _, choice in ipairs(clause.candidates) do
                check(choice.text ~= "鳥" and choice.text ~= "鶏" and choice.text ~= "誤表記",
                    "reranking never imports candidates from the foreign reading: " .. foreign)
            end
        end
    end
end

print("== 25. resizing settles compatible routes while retaining an outer filtered selection")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 1 },
        { surface = "あ", candidate = "赤", left_id = 1898, right_id = 1898, cost = 1 },
        { surface = "いさ", candidate = "元", left_id = 1841, right_id = 1841, cost = 1 },
        { surface = "かな", candidate = "鉛", left_id = 1909, right_id = 1909, cost = 1 },
        { surface = "い", candidate = "左1", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "左2", left_id = 695, right_id = 695, cost = 100 },
        { surface = "さかな", candidate = "右", left_id = 1851, right_id = 1851, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1898, 1841, 1909, 694, 695 }, {
        ["1851 1841"] = 0, ["1898 1841"] = 100,
        ["1851 694"] = 10, ["1851 695"] = 20,
        ["1898 694"] = 5, ["1898 695"] = 0,
    })
    local readings = {}
    for _, row in ipairs(dictionary) do
        readings[row.surface] = readings[row.surface] or {}
        table.insert(readings[row.surface], { text = row.candidate,
            phrase = { text = row.candidate .. "|" .. row.left_id .. " " .. row.right_id,
                custom_code = row.surface .. " " } })
    end
    for _, filtered in ipairs({ false, true }) do
        local expand = function(candidate)
            if candidate.text == "赤" then yield(ShadowCandidate(candidate, "simplified", "🔴", "")) end
        end
        local bunsetsu, context = new_engine(dictionary, matrix, readings, expand, function() return true end)
        bunsetsu.start(context, "あいさかな")
        local state = bunsetsu.state(context)
        check(bunsetsu.display(context) == "赤元鉛", "the original dictionary frame has three clauses before resize")
        if filtered then
            check(select_clause_text(bunsetsu, context, 1, "🔴"), "the outer filter addition is selectable before resize")
        end
        local outer_text = filtered and "🔴" or "赤"
        state.active = 2
        context:set_option("_kagiroi_hide_candidates", true)
        bunsetsu.resize(context, -1)
        local outer, left, right = state.clauses[1], state.clauses[2], state.clauses[3]
        check(left.reading == "い" and right.reading == "さかな"
            and selected_route(bunsetsu, context, 2)[1].left_id == 695,
            "resize reparses both readings and selects the best compatible lexical route")
        check(outer.candidates[outer.selected].text == outer_text
            and outer.candidates[outer.selected].left_id == 1898,
            "the outer display is retained while its best compatible source route changes")
        check(left.selected == 1 and left.candidates[1].text == "左2"
            and right.selected == 1 and right.candidates[1].text == "右",
            "both resized selections follow independent final-neighbor connection minima")
        local expected = outer_text .. "左2右"
        for _ = 1, 3 do
            bunsetsu.render(context)
            check(bunsetsu.display(context) == expected, "repeated publication retains the settled choices and filter addition")
        end
    end
end

print("== 26. absorbing a clause retains the selected display of its successor")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "え", candidate = "絵A", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "え", candidate = "絵B", left_id = 1898, right_id = 1898, cost = 200 },
    }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898 }), {}, function() return true end)
    bunsetsu.start(context, "あいうえ")
    check(select_clause_text(bunsetsu, context, 4, "絵B"), "the successor starts from a nonfirst same-POS selection")
    local state = bunsetsu.state(context)
    state.active = 2
    context:set_option("_kagiroi_hide_candidates", true)
    bunsetsu.resize(context, 1)
    check(#state.clauses == 3 and state.clauses[2].reading == "いう" and state.clauses[2].selected == 1,
        "extension absorbs the next clause and selects the merged frame's first candidate")
    check(state.clauses[3].reading == "え" and bunsetsu.display(context) == "亜伊宇絵B",
        "the clause after the removed boundary keeps its selected display")
end

print("== 27. relearning a deduped winner refreshes the same engine and retains its lexical identity")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あ", candidate = "朱", left_id = 1851, right_id = 1851, cost = 300 },
        { surface = "あ", candidate = "朱", left_id = 1898, right_id = 1898, cost = 400 },
    }
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898 }), histories)
    bunsetsu.start(context, "あ")
    check(bunsetsu.display(context) == "赤", "the target begins below the ordinary first candidate")
    for round = 1, 3 do
        check(select_clause_text(bunsetsu, context, 1, "朱"), "the deduped target remains selectable in learning round " .. round)
        record_learning(bunsetsu, context, histories)
        bunsetsu.start(context, "あ")
        check(bunsetsu.display(context) == "朱" and selected_route(bunsetsu, context)[1].left_id == 1851,
            "the same engine sees new learning and retains the selected POS in round " .. round)
        check(#histories == 2 and histories[1].commit_count == round
            and histories[1].text == "朱|1851 1851\tp2:c あ,朱,1851,1851"
            and history_count(histories, "あ|1851 1851\tb1 1") == round,
            "relearning increases only the actual selected route's counter in round " .. round)
    end
end

print("== 28. same-text histories with shared endpoints keep different middle-word frames separate")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1920, right_id = 1920, cost = 1000 },
        { surface = "う", candidate = "宇", left_id = 1909, right_id = 1909, cost = 100 },
    }
    local histories = {}
    local matrix = pos_matrix({ 1851, 1841, 1920, 1909 })
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    record_learning(bunsetsu, context, histories)
    local first_history = "亜伊宇|1851 1851\tp2:c あ,亜,1851,1851;い,伊,1841,1841;う,宇,1909,1909"
    local second_history = "亜伊宇|1851 1851\tp2:c あ,亜,1851,1851;い,伊,1920,1920;う,宇,1909,1909"
    check(histories[1].text == first_history, "learning records the complete route including its middle word")
    dictionary[2].cost, dictionary[3].cost = 20000, 100
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    local clause = bunsetsu.state(context).clauses[1]
    check(clause.candidates[clause.selected].route_words[2].left_id == 1920,
        "a sufficiently cheaper middle-word route defeats the finite discount on the previous route")
    check(clause.unfiltered[1].own == 300, "shared endpoints do not transfer the previous middle-word discount")
    for _ = 1, 2 do
        record_learning(bunsetsu, context, histories)
        bunsetsu.start(context, "あいう")
    end
    check(#histories == 3 and history_count(histories, first_history) == 1
        and history_count(histories, second_history) == 2,
        "the two identical displays maintain independent middle-word counters")
    dictionary[2].cost, dictionary[3].cost = 100, 30000
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, first_history) == 2 and history_count(histories, second_history) == 2,
        "returning to the original route relearns only its own complete route")
end

print("== 29. single-word and multiword histories compete while retaining independent counters")
do
    local dictionary = {
        { surface = "ないで", candidate = "内で", left_id = 1851, right_id = 1851, cost = 50 },
        { surface = "ない", candidate = "内", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "で", candidate = "で", left_id = 1909, right_id = 1909, cost = 100 },
        { surface = "たべ", candidate = "食べ", left_id = 694, right_id = 694, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1841, 1909, 694 }, { ["694 1851"] = 50000 })
    local boundary = function(right_id) return right_id == 694 end
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, boundary)
    bunsetsu.start(context, "ないで")
    record_learning(bunsetsu, context, histories)
    check(histories[1].text == "内で|1851 1851\tp2:c ないで,内で,1851,1851", "the standalone frame records its one-word route")
    for _ = 1, 3 do
        bunsetsu.start(context, "たべないで")
        local clauses = bunsetsu.state(context).clauses
        check(#clauses == 2 and #selected_route(bunsetsu, context, 2) == 2
            and bunsetsu.display(context) == "食べ内で",
            "verb context selects the multiword route")
        record_learning(bunsetsu, context, histories)
    end
    local single_history = "内で|1851 1851\tp2:c ないで,内で,1851,1851"
    local multi_history = "内で|1851 1851\tp2:c ない,内,1841,1841;で,で,1909,1909"
    check(history_count(histories, single_history) == 1 and history_count(histories, multi_history) == 3,
        "single-word and multiword histories over the same reading and display have separate counters")
    bunsetsu.start(context, "ないで")
    local clause = bunsetsu.state(context).clauses[1]
    check(#clause.candidates[clause.selected].route_words == 2,
        "more commits can promote the multiword route even without the verb context")
    record_learning(bunsetsu, context, histories)
    check(history_count(histories, single_history) == 1 and history_count(histories, multi_history) == 4,
        "standalone confirmation increments the selected multiword route, not the old single-word route")
end

print("== 30. clause and whole-sentence histories have independent counters for the same word route")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
    }
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1841 }), histories, function() return true end)
    bunsetsu.start(context, "あい")
    record_learning(bunsetsu, context, histories)
    check(#histories == 4 and histories[3].text == "亜伊|1851 1851\tp2:s あ,亜,1851,1851;い,伊,1841,1841"
        and history_count(histories, "あい|1851 1851\tb1 1,1") == 1,
        "the listed two-clause selection stores both clauses and its complete sentence route")
    bunsetsu.start(context, "あい")
    context:set_option("_kagiroi_hide_candidates", true)
    bunsetsu.resize(context, 1)
    record_learning(bunsetsu, context, histories)
    record_learning(bunsetsu, context, histories)
    check(#histories == 6 and histories[3].commit_count == 1
        and history_count(histories, "亜伊|1851 1851\tp2:c あ,亜,1851,1851;い,伊,1841,1841") == 2
        and history_count(histories, "あい|1851 1851\tb1 2") == 2,
        "merging and relearning the same words grows only the clause-scoped counter")
end

print("== 31. a learned subword discounts only its original ids inside a fixed multiword frame")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 5000 },
        { surface = "あ", candidate = "亜", left_id = 1898, right_id = 1898, cost = 5000 },
        { surface = "あ", candidate = "阿", left_id = 1851, right_id = 1851, cost = 1000 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
    }
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898, 1841 }), histories, function() return false end)
    bunsetsu.start(context, "あ")
    check(select_clause_text(bunsetsu, context, 1, "亜"), "the single-word route can be selected for subword training")
    record_learning(bunsetsu, context, histories)
    bunsetsu.start(context, "あい")
    local clause = bunsetsu.state(context).clauses[1]
    local learned_own, other_own
    for _, choice in ipairs(clause.unfiltered) do
        if choice.text == "亜伊" and choice.left_id == 1851 then learned_own = choice.own end
        if choice.text == "亜伊" and choice.left_id == 1898 then other_own = choice.own end
    end
    check(#selected_route(bunsetsu, context) == 2 and bunsetsu.display(context) == "亜伊"
        and learned_own == 5100 - 10000 and other_own == 5100,
        "only the trained word identity receives the finite history discount inside the multiword route")
end

print("== 32. legacy partial histories retain stored rows and actual words at every interval position")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 5000 },
        { surface = "あ", candidate = "阿", left_id = 1898, right_id = 1898, cost = 1000 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1909, right_id = 1909, cost = 100 },
    }
    local cases = {
        { surface = "あ", candidate = "亜", readings = {
            { "あ", "亜" }, { "あい", "亜伊" }, { "いあ", "伊亜" }, { "いあう", "伊亜宇" },
        }, saved = "伊亜宇|1851 1851\tp2:c い,伊,1841,1841;あ,亜,1851,1851;う,宇,1909,1909" },
        { surface = "あい", candidate = "亜伊", readings = {
            { "あい", "亜伊" }, { "あいう", "亜伊宇" }, { "うあい", "宇亜伊" }, { "うあいう", "宇亜伊宇" },
        }, saved = "宇亜伊宇|1851 1851\tp2:c う,宇,1909,1909;あ,亜,1851,1851;い,伊,1841,1841;う,宇,1909,1909" },
    }
    for _, case in ipairs(cases) do
        for _, encoded in ipairs({ false, true }) do
            local legacy = { surface = case.surface, candidate = case.candidate,
                left_id = 1851, right_id = 1851, commit_count = 1000000 }
            if encoded then legacy.text = case.candidate .. "|1851 1851" end
            local stored_text = legacy.text
            local histories = { legacy }
            local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898, 1841, 1909 }), histories,
                function() return false end)
            for _, reading in ipairs(case.readings) do
                bunsetsu.start(context, reading[1])
                check(bunsetsu.display(context) == reading[2]
                    and #selected_route(bunsetsu, context) == utf8.len(reading[1]),
                    "legacy learning ranks only the original word slots in " .. reading[1])
            end
            record_learning(bunsetsu, context, histories)
            check(#histories == 3 and legacy.text == stored_text and legacy.candidate == case.candidate
                and legacy.commit_count == 1000000 and legacy.left_id == 1851 and legacy.right_id == 1851,
                "adding route-aware learning does not rewrite or merge the existing legacy record")
            check(histories[2].text == case.saved and histories[2].commit_count == 1,
                "relearning stores actual dictionary words instead of a synthetic legacy word")
        end
    end
end

print("== 33. long-vowel kana learning is visible after reconversion and a new engine")
do
    local dictionary = {
        { surface = "かれー", candidate = "カレー", left_id = 1898, right_id = 1898, cost = 100 },
        { surface = "かれー", candidate = "かれー", left_id = 1851, right_id = 1851, cost = 300 },
    }
    local matrix, histories = pos_matrix({ 1851, 1898 }), {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories)
    bunsetsu.start(context, "かれー")
    check(select_clause_text(bunsetsu, context, 1, "かれー"), "the lower-ranked long-vowel kana dictionary candidate is selectable")
    record_learning(bunsetsu, context, histories)
    check(histories[1].text == "かれー|1851 1851\tp2:c かれー,かれー,1851,1851",
        "kana learning records the long vowel and original route ids")
    bunsetsu.start(context, "かれー")
    check(bunsetsu.display(context) == "かれー", "reconversion in the same engine uses the new kana history")
    bunsetsu, context = pos_engine(dictionary, matrix, histories)
    bunsetsu.start(context, "かれー")
    check(bunsetsu.display(context) == "かれー", "a new engine restores the saved long-vowel kana history")
end

print("== 34. auxiliary learning cannot be reused by a noun-only frame with the same display")
do
    local dictionary = {
        { surface = "ない", candidate = "ない", left_id = 213, right_id = 213, cost = 100 },
        { surface = "ない", candidate = "ない", left_id = 1954, right_id = 1954, cost = 5000 },
    }
    local matrix, histories = pos_matrix({ 213, 1954 }), {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories)
    bunsetsu.start(context, "ない")
    record_learning(bunsetsu, context, histories)
    table.remove(dictionary, 1)
    bunsetsu, context = pos_engine(dictionary, matrix, histories)
    bunsetsu.start(context, "ない")
    local clause = bunsetsu.state(context).clauses[1]
    check(clause.candidates[clause.selected].left_id == 1954 and clause.unfiltered[1].own == 5000,
        "a noun-only frame keeps its original identity and cost despite the auxiliary history")
    record_learning(bunsetsu, context, histories)
    check(#histories == 3 and histories[1].commit_count == 1
        and history_count(histories, "ない|1851 1851\tp2:c ない,ない,1954,1954") == 1,
        "noun learning creates a separate route history instead of growing the auxiliary counter")
end

print("== 35. malformed route suffixes are skipped without hiding the following valid history")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 5000 },
        { surface = "あ", candidate = "阿", left_id = 1898, right_id = 1898, cost = 1000 },
    }
    local suffixes = {
        "\tp2:c %FF,亜,1851,1851", "\tp2:c あ,%FF,1851,1851",
        "\tp2:c い,亜,1851,1851", "\tp2:c あ,阿,1851,1851",
        "\tp2:c あ,亜,1851,1851;", "\tp2:c ;あ,亜,1851,1851",
        "\tp2:c あ,亜,1851,1851;;あ,亜,1851,1851",
        "\tp2:c ,亜,1851,1851", "\tp2:c あ,,1851,1851",
        "\tp2:c %GG,亜,1851,1851", "\tp2:c bogus", "\tp2:c ",
        "\tp2:x あ,亜,1851,1851", "\tp2:c あ,亜," .. string.rep("9", 400) .. ",1851",
    }
    for _, suffix in ipairs(suffixes) do
        local malformed = { surface = "あ", text = "亜|1851 1851" .. suffix, commit_count = 1000000 }
        local histories = { malformed,
            { surface = "あ", text = "阿|1851 1851\tp2:c あ,阿,1898,1898", commit_count = 1 },
        }
        local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898 }), histories)
        bunsetsu.start(context, "あ")
        local clause = bunsetsu.state(context).clauses[1]
        local rejected, accepted
        for _, choice in ipairs(clause.unfiltered) do
            if choice.text == "亜" then rejected = choice end
            if choice.text == "阿" then accepted = choice end
        end
        check(rejected and rejected.own == 5000 and accepted and accepted.own == 1000 - 10000
            and bunsetsu.display(context) == "阿", "invalid suffix is not a legacy discount and the following valid row remains readable: " .. suffix)
        check(#histories == 2 and malformed.text == "亜|1851 1851" .. suffix and malformed.commit_count == 1000000,
            "rejecting a malformed suffix does not rewrite its stored row")
    end
end

print("== 36. both reshaped clauses select their first candidate under each other's final compatible route")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1909, right_id = 1909, cost = 1 },
        { surface = "いさ", candidate = "元", left_id = 1841, right_id = 1841, cost = 1 },
        { surface = "かな", candidate = "鉛", left_id = 1920, right_id = 1920, cost = 1 },
        { surface = "い", candidate = "取1", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "取2", left_id = 695, right_id = 695, cost = 100 },
        { surface = "さかな", candidate = "魚1", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "さかな", candidate = "魚2", left_id = 1898, right_id = 1898, cost = 100 },
    }
    local matrix = pos_matrix({ 1909, 1841, 1920, 694, 695, 1851, 1898 }, {
        ["694 1851"] = 9000, ["694 1898"] = 10,
        ["695 1851"] = 10, ["695 1898"] = 9000,
    })
    local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return true end)
    bunsetsu.start(context, "あいさかな")
    local state = bunsetsu.state(context)
    state.active = 2
    context:set_option("_kagiroi_hide_candidates", true)
    bunsetsu.resize(context, -1)
    local left, right = state.clauses[2], state.clauses[3]
    local left_choice, right_choice = left.candidates[left.selected], right.candidates[right.selected]
    local final_connection = matrix[left_choice.right_id .. " " .. right_choice.left_id]
    check(left.reading == "い" and right.reading == "さかな" and left.selected == 1 and right.selected == 1,
        "both changed clauses initialize to the final filtered first candidate in their new fixed frames")
    for _, id in ipairs({ 694, 695 }) do
        check(final_connection <= matrix[id .. " " .. right_choice.left_id],
            "the left first minimizes independent costs under the final right selection")
    end
    for _, id in ipairs({ 1851, 1898 }) do
        check(final_connection <= matrix[left_choice.right_id .. " " .. id],
            "the right first minimizes independent costs under the final left selection")
    end
    check(bunsetsu.display(context) == "赤" .. left_choice.text .. right_choice.text,
        "settling both reshaped sides preserves the unreshaped outer display")
end

print("== 37. a same-POS middle-word history beats a cheaper competing route without leaking after removal")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1851, right_id = 1851, cost = 1000 },
        { surface = "い", candidate = "伊", left_id = 1898, right_id = 1898, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1909, right_id = 1909, cost = 100 },
    }
    local matrix, histories = pos_matrix({ 1841, 1851, 1898, 1909 }), {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    record_learning(bunsetsu, context, histories)
    local saved = "亜伊宇|1851 1851\tp2:c あ,亜,1841,1841;い,伊,1898,1898;う,宇,1909,1909"
    check(#histories == 2 and histories[1].text == saved, "training stores the original middle word with shared endpoints")
    dictionary[2].cost = 10
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    local clause = bunsetsu.state(context).clauses[1]
    local selected = clause.candidates[clause.selected]
    check(dictionary[2].cost < dictionary[3].cost and selected.route_words[2].left_id == 1898
        and selected.left_id == 1841 and selected.right_id == 1909 and bunsetsu.display(context) == "亜伊宇",
        "learning preserves the middle lexical identity even when a same-POS competitor becomes cheaper")
    record_learning(bunsetsu, context, histories)
    check(#histories == 2 and histories[1].text == saved and histories[1].commit_count == 2,
        "deduplication and relearning grow only the selected middle-word history")
    table.remove(dictionary, 3)
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    clause = bunsetsu.state(context).clauses[1]
    check(clause.candidates[clause.selected].route_words[2].left_id == 1851,
        "removing the trained middle word leaves the competing same-POS route selectable")
    for _, choice in ipairs(clause.unfiltered) do
        check(choice.route_words[2].left_id == 1851 and choice.own == 210,
            "the remaining route keeps its independent word cost and receives no removed-word discount")
    end
    check(histories[1].text == saved and histories[1].commit_count == 2,
        "ignoring an unavailable middle-word history does not rewrite its stored row")
end

print("== 38. initial conversion settles a changed same-text representative before selecting its neighbor")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あ", candidate = "赤", left_id = 1898, right_id = 1898, cost = 100 },
        { surface = "い", candidate = "鳥", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "取", left_id = 695, right_id = 695, cost = 200 },
    }
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1851 694"] = 0, ["1851 695"] = 1000,
        ["1898 694"] = 500, ["1898 695"] = 0,
    })
    local histories = {
        { surface = "あ", text = "赤|1851 1851\tp2:c あ,赤,1898,1898", commit_count = 1 },
    }
    local bunsetsu, context, viterbi = pos_engine(dictionary, matrix, histories, function() return true end)
    viterbi:analyze("あい")
    local initial = viterbi:best_n()()
    check(initial.candidate == "赤鳥" and initial.left_id == 1851 and initial.right_id == 694,
        "the upstream beam initially supplies the unlearned red1851 and bird694 path")
    bunsetsu.start(context, "あい")
    local state = bunsetsu.state(context)
    local left, right = state.clauses[1], state.clauses[2]
    check(left.reading == "あ" and right.reading == "い"
        and selected_route(bunsetsu, context, 1)[1].left_id == 1898
        and selected_route(bunsetsu, context, 2)[1].left_id == 695,
        "initial clauses retain their reading boundaries and use the best learned and connected lexical ids")
    check(#left.candidates == 1 and left.candidates[left.selected].left_id == 1898,
        "the first conversion must switch the deduped representative to the learned same-POS route")
    local bird_cost = 100 + matrix["1898 694"]
    local alternative_cost = 200 + matrix["1898 695"]
    check(alternative_cost == 200 and bird_cost == 600 and alternative_cost < bird_cost,
        "independent costs under the final representative require the alternate neighbor")
    check(right.selected == 1 and right.candidates[1].text == "取"
        and right.candidates[right.selected].left_id == 695 and bunsetsu.display(context) == "赤取",
        "initial neighbor order selection and preview all use the final representative rather than its beam seed")
end

print("== 39. choosing the left clause reverses the right ranking while retaining its selected display")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あ", candidate = "朱", left_id = 1898, right_id = 1898, cost = 200 },
        { surface = "い", candidate = "鳥", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "鶏", left_id = 695, right_id = 695, cost = 200 },
    }
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1851 694"] = 0, ["1851 695"] = 1000,
        ["1898 694"] = 1000, ["1898 695"] = 0,
    })
    local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return true end)
    bunsetsu.start(context, "あい")
    local right = bunsetsu.state(context).clauses[2]
    check(right.candidates[1].text == "鳥" and right.candidates[right.selected].text == "鳥"
        and 100 + matrix["1851 694"] < 200 + matrix["1851 695"],
        "before left selection the right head and selected display follow the original independent minimum")
    check(select_clause_text(bunsetsu, context, 1, "朱"), "a different same-POS left candidate remains selectable")
    check(200 + matrix["1898 695"] < 100 + matrix["1898 694"]
        and right.candidates[1].text == "鶏" and right.candidates[right.selected].text == "鳥"
        and bunsetsu.display(context) == "朱鳥",
        "left selection reverses the right head without replacing its existing selected display")
    check(select_clause_text(bunsetsu, context, 1, "赤") and right.candidates[1].text == "鳥"
        and right.candidates[right.selected].text == "鳥" and bunsetsu.display(context) == "赤鳥",
        "returning to the original left candidate restores the right order without changing its display")
end

print("== 40. a resized pair settles a long chain of same-text representatives to independent final-context minima")
do
    local prefix_readings = { "あ", "い", "う", "え", "お", "か", "き", "く" }
    local dictionary, word_costs = {}, {}
    for index, reading in ipairs(prefix_readings) do
        word_costs[reading] = { [1851] = 2, [1898] = 1 }
        for _, id in ipairs({ 1851, 1898 }) do
            dictionary[#dictionary + 1] = { surface = reading, candidate = "同" .. index,
                left_id = id, right_id = id, cost = word_costs[reading][id] }
        end
    end
    dictionary[#dictionary + 1] = { surface = "とりさ", candidate = "元", left_id = 1841, right_id = 1841, cost = 1 }
    dictionary[#dictionary + 1] = { surface = "とり", candidate = "取", left_id = 1851, right_id = 1851, cost = 5000 }
    dictionary[#dictionary + 1] = { surface = "とり", candidate = "取", left_id = 1898, right_id = 1898, cost = 100 }
    dictionary[#dictionary + 1] = { surface = "さ", candidate = "魚", left_id = 694, right_id = 694, cost = 100 }
    dictionary[#dictionary + 1] = { surface = "さ", candidate = "魚", left_id = 695, right_id = 695, cost = 100 }
    word_costs["とり"] = { [1851] = 5000, [1898] = 100 }
    word_costs["さ"] = { [694] = 100, [695] = 100 }
    local matrix = pos_matrix({ 1851, 1898, 1841, 694, 695 }, {
        ["0 1898"] = 10000, ["1851 1898"] = 1000, ["1898 1841"] = 10000,
        ["1851 694"] = 0, ["1851 695"] = 1000,
        ["1898 694"] = 1000, ["1898 695"] = 0,
    })
    local prefix = table.concat(prefix_readings)
    for repetition = 1, 3 do
        local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return true end)
        bunsetsu.start(context, prefix .. "とりさ")
        local state = bunsetsu.state(context)
        for index = 1, #prefix_readings do
            local clause = state.clauses[index]
            check(selected_route(bunsetsu, context, index)[1].left_id == 1851
                and clause.candidates[clause.selected].left_id == 1851,
                "the initial ordinary path starts every prefix representative on its original id")
        end
        state.active = #state.clauses
        context:set_option("_kagiroi_hide_candidates", true)
        bunsetsu.resize(context, -1)
        check(#state.clauses == #prefix_readings + 2
            and state.clauses[#prefix_readings + 1].reading == "とり"
            and state.clauses[#prefix_readings + 2].reading == "さ",
            "the boundary change regenerates the final pair without changing any prefix reading")
        local expected_ids = { 1851, 1898, 1898, 1898, 1898, 1898, 1898, 1898, 1898, 695 }
        local expected_display = "同1同2同3同4同5同6同7同8取魚"
        for index, clause in ipairs(state.clauses) do
            local chosen = clause.candidates[clause.selected]
            check(chosen.left_id == expected_ids[index],
                "the final same-text representative is stable across the full chain at clause " .. index)
            local previous = state.clauses[index - 1]
            local following = state.clauses[index + 1]
            local previous_id = previous and previous.candidates[previous.selected].right_id or 0
            local following_id = following and following.candidates[following.selected].left_id or 0
            local costs = word_costs[clause.reading]
            local chosen_cost = costs[chosen.left_id]
                + matrix[previous_id .. " " .. chosen.left_id] + matrix[chosen.right_id .. " " .. following_id]
            for id, own in pairs(costs) do
                local alternative = own + matrix[previous_id .. " " .. id] + matrix[id .. " " .. following_id]
                check(chosen_cost <= alternative,
                    "each final representative minimizes independent costs under both final neighbors at clause " .. index)
            end
        end
        check(state.clauses[#prefix_readings + 1].selected == 1
            and state.clauses[#prefix_readings + 2].selected == 1 and bunsetsu.display(context) == expected_display,
            "both resized clauses select their settled heads while all prefix displays remain unchanged")
        for _ = 1, 3 do
            bunsetsu.render(context)
            check(bunsetsu.display(context) == expected_display, "repeated publication retains the full settled display")
            for index, clause in ipairs(state.clauses) do
                check(clause.candidates[clause.selected].left_id == expected_ids[index],
                    "repeated publication cannot move a settled representative at clause " .. index)
            end
        end
    end
end

print("== 41. resized same-text routes switch identities and retain a stable equal-cost representative")
do
    local dictionary = {
        { surface = "とりさ", candidate = "元", left_id = 1841, right_id = 1841, cost = 1 },
        { surface = "とり", candidate = "同", left_id = 694, right_id = 694, cost = 500 },
        { surface = "とり", candidate = "同", left_id = 695, right_id = 695, cost = 500 },
        { surface = "とり", candidate = "同", left_id = 694, right_id = 695, cost = 500 },
        { surface = "さ", candidate = "魚", left_id = 1851, right_id = 1851, cost = 500 },
        { surface = "さ", candidate = "魚", left_id = 1898, right_id = 1898, cost = 500 },
    }
    local matrix = pos_matrix({ 1841, 694, 695, 1851, 1898 }, {
        ["694 1851"] = 10, ["694 1898"] = 10,
        ["695 1851"] = 5, ["695 1898"] = 1,
    })
    for repetition = 1, 3 do
        local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return false end)
        bunsetsu.start(context, "とりさ")
        context:set_option("_kagiroi_hide_candidates", true)
        bunsetsu.resize(context, -1)
        local state = bunsetsu.state(context)
        local left, right = state.clauses[1], state.clauses[2]
        local chosen_left, chosen_right = left.candidates[left.selected], right.candidates[right.selected]
        check(#left.candidates == 1 and #right.candidates == 1 and left.selected == 1 and right.selected == 1,
            "same-text route changes retain one final first candidate per resized clause")
        check(chosen_left.left_id == 694 and chosen_left.right_id == 695 and chosen_right.left_id == 1898,
            "both representative identities switch beyond their stock rows and retain stable tie order")
        local tied_left_ids = {}
        for _, choice in ipairs(left.unfiltered) do
            if choice.right_id == 695 and choice.own == 500 then tied_left_ids[choice.left_id] = true end
        end
        check(tied_left_ids[694] and tied_left_ids[695], "both equal-cost best left routes remain materialized after deduplication")
        check(500 + matrix["695 1898"] == 501 and 500 + matrix["694 1898"] == 510
            and 500 + matrix["695 1851"] == 505,
            "independent final-context costs favor the chosen right id and tie both best left routes")
        for _ = 1, 3 do
            bunsetsu.render(context)
            check(bunsetsu.display(context) == "同魚" and left.candidates[left.selected].left_id == 694
                and left.candidates[left.selected].right_id == 695 and right.candidates[right.selected].left_id == 1898,
                "equal-cost same-text representatives and preview remain unchanged after publication")
        end
    end
end

print(string.format("bunsetsu: %d checks, %d failures", checks, failures))
os.exit(failures == 0 and 0 or 1)
