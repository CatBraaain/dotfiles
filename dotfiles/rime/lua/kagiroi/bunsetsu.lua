-- Per-context clause choices, the active-clause menu and the full preview.
local Top = {}
local sessions = {}
local next_session = 0
local stock
local variants = require("kagiroi/char_variants")
local segmenter_loaded, segmenter = pcall(require, "kagiroi/segmenter")

local kContextualDiscoveryLimit = 30
local kKanjiCandidateId = 1920
local kHistoryIds = "1851 1851"
local kHistoryMarker = "\tp2"
local kLearningScale = 10000
local kUnknownWordCost = 10000
local kBoundaryMarker = "\tb1 "

local function node_words(node)
    local words = node.expanded_words
    if not words then
        words = node.route_words or { node }
        node.expanded_words = words
    end
    return words
end

local function word_route_precedes(a, b)
    for index = 1, math.min(#a, #b) do
        if a[index]._end ~= b[index]._end then return a[index]._end < b[index]._end end
    end
    if #a ~= #b then return #a < #b end
    for index = 1, #a do
        local left, right = a[index].dictionary_order or 0, b[index].dictionary_order or 0
        if left ~= right then return left < right end
    end
    return false
end

local function chain_words(node, completions)
    local cache = completions.chain_words_cache
    if not cache then
        cache = {}
        completions.chain_words_cache = cache
    end
    local words = cache[node]
    if not words then
        words = {}
        local current = node
        while current do
            local expanded = node_words(current)
            for _, word in ipairs(expanded) do words[#words + 1] = word end
            current = completions[current]
        end
        cache[node] = words
    end
    return words
end

local function prefix_words(state)
    local words = state.words
    if not words then
        local nodes, head = {}, state
        while state do
            nodes[#nodes + 1] = state.node
            state = state.prev
        end
        words = {}
        for index = #nodes, 1, -1 do
            local expanded = node_words(nodes[index])
            for _, word in ipairs(expanded) do words[#words + 1] = word end
        end
        head.words = words
    end
    return words
end

local function path_completion_words(item, completions)
    local words = item.completion_words
    if not words then
        words = {}
        for _, word in ipairs(prefix_words(item.prefix)) do words[#words + 1] = word end
        local node = completions[item.node]
        while node do
            local expanded = node_words(node)
            for _, word in ipairs(expanded) do words[#words + 1] = word end
            node = completions[node]
        end
        item.completion_words = words
    end
    return words
end

local function path_precedes(a, b, completions)
    if a.score ~= b.score then return a.score < b.score end
    if word_route_precedes(path_completion_words(a, completions), path_completion_words(b, completions)) then return true end
    if word_route_precedes(path_completion_words(b, completions), path_completion_words(a, completions)) then return false end
    if a.node._end ~= b.node._end then return a.node._end > b.node._end end
    return a.sequence < b.sequence
end

local function starts_with_youon(text)
    local initial = utf8.codepoint(text, 1)
    local youon = { 0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3083, 0x3085, 0x3087 }
    for _, codepoint in ipairs(youon) do
        if initial == codepoint then return true end
    end
    return false
end

local function userdict_cost(surface, commit_count)
    local base_cost = 5000
    local length_penalty = math.max(1, 2.0 - utf8.len(surface) * 0.3)
    local frequency_bonus = math.log(commit_count + 2) / math.log(2)
    return math.floor(math.max(500, base_cost * length_penalty / frequency_bonus))
end

local function history_bonus(commit_count)
    return math.floor(kLearningScale * math.log(commit_count + 1) / math.log(2))
end

local function lexical_history_bonus(history, reading_length)
    local history_length = utf8.len(history.reading)
    local coverage = history_length * (history_length + 1) / (reading_length * (reading_length + 1))
    return math.floor(history_bonus(history.commit_count) * coverage)
end

local function escape_history_field(value)
    return (string.gsub(value, "[%,%;%%%s]", function(character)
        return string.format("%%%02X", string.byte(character))
    end))
end

local function unescape_history_field(value)
    if string.gsub(value, "%%%x%x", ""):find("%", 1, true) then return nil end
    return (string.gsub(value, "%%(%x%x)", function(hex)
        return string.char(tonumber(hex, 16))
    end))
end

local function history_suffix(scope, route)
    local marker = kHistoryMarker .. ":" .. scope
    if not route or #route == 0 then return marker end
    local words = {}
    for _, word in ipairs(route) do
        words[#words + 1] = table.concat({
            escape_history_field(word.surface), escape_history_field(word.candidate),
            tostring(word.left_id), tostring(word.right_id),
        }, ",")
    end
    return marker .. " " .. table.concat(words, ";")
end

local route_signatures = setmetatable({}, { __mode = "k" })

local function route_signature(route)
    if not route then return kHistoryMarker .. ":c" end
    local signature = route_signatures[route]
    if not signature then
        signature = history_suffix("c", route)
        route_signatures[route] = signature
    end
    return signature
end

local function parse_history_suffix(rest, reading, text)
    if rest == "" then return nil, true end
    if reading == "" or text == "" or not utf8.len(reading) or not utf8.len(text) then
        return nil, false
    end
    if string.match(rest, "^" .. kHistoryMarker .. ":[cs]$") then return nil, true end
    local encoded = string.match(rest, "^" .. kHistoryMarker .. ":[cs] (.+)$")
    if not encoded or encoded:sub(1, 1) == ";" or encoded:sub(-1) == ";"
        or encoded:find(";;", 1, true) then return nil, false end
    local route, readings, texts = {}, {}, {}
    for word in string.gmatch(encoded, "[^;]+") do
        local surface, candidate, left_id, right_id =
            string.match(word, "^([^,]+),([^,]+),(-?%d+),(-?%d+)$")
        if not surface then return nil, false end
        surface, candidate = unescape_history_field(surface), unescape_history_field(candidate)
        left_id, right_id = math.tointeger(left_id), math.tointeger(right_id)
        if not surface or not candidate or surface == "" or candidate == ""
            or not utf8.len(surface) or not utf8.len(candidate)
            or not left_id or not right_id then return nil, false end
        route[#route + 1] = {
            surface = surface, candidate = candidate,
            left_id = left_id, right_id = right_id,
        }
        readings[#readings + 1], texts[#texts + 1] = surface, candidate
    end
    if table.concat(readings) ~= reading or table.concat(texts) ~= text then return nil, false end
    return route, true
end



local function install_userdict_reader(env)
    local mem, viterbi = env.mem, env.viterbi
    if not (mem and mem.user_lookup and mem.iter_user) then return end
    viterbi.query_userdict = function(input)
        if not input or input == "" or starts_with_youon(input) then
            return function() return nil end
        end
        mem:user_lookup(input .. " \t", true)
        local next_entry, state = mem:iter_user()
        return function()
            while true do
                local entry = next_entry(state)
                if not entry then return nil end
                local commit_count = entry.commit_count or 1
                local surface = (string.gsub(entry.custom_code, "%s+$", ""))
                local display, left_id, right_id, rest =
                    string.match(entry.text, "^(.*)|(-?%d+) (-?%d+)(.*)$")
                if not display then
                    return {
                        surface = surface, left_id = -1, right_id = -1, candidate = entry.text,
                        cost = 50 / (commit_count + 1), learned = true,
                        commit_count = commit_count, route = nil,
                    }
                end
                local route, valid = parse_history_suffix(rest, surface, display)
                if valid then
                    return {
                        surface = surface, left_id = tonumber(left_id), right_id = tonumber(right_id),
                        candidate = display, cost = userdict_cost(surface, commit_count),
                        learned = true, commit_count = commit_count, route = route,
                    }
                end
            end
        end
    end
end

local function heap_push(heap, item, completions)
    heap[#heap + 1] = item
    local index = #heap
    while index > 1 do
        local parent = math.floor(index / 2)
        if not path_precedes(heap[index], heap[parent], completions) then break end
        heap[parent], heap[index] = heap[index], heap[parent]
        index = parent
    end
end

local function heap_pop(heap, completions)
    local top = heap[1]
    local last = table.remove(heap)
    if #heap > 0 then
        heap[1] = last
        local index = 1
        while true do
            local left, right, smallest = index * 2, index * 2 + 1, index
            if left <= #heap and path_precedes(heap[left], heap[smallest], completions) then smallest = left end
            if right <= #heap and path_precedes(heap[right], heap[smallest], completions) then smallest = right end
            if smallest == index then break end
            heap[index], heap[smallest] = heap[smallest], heap[index]
            index = smallest
        end
    end
    return top
end

function Top.init(env)
    stock = stock or require("kagiroi/kagiroi_translator")
    stock.init(env)
    install_userdict_reader(env)
    next_session = next_session + 1
    env.session_id = tostring(next_session)
    env.engine.context:set_property("_kagiroi_bunsetsu_session", env.session_id)
    sessions[env.session_id] = env
    local context = env.engine.context
    env.option_connection = context.option_update_notifier:connect(function(_, option)
        if option == "_kagiroi_hide_candidates" and not context:get_option(option) and env.conversion then
            env.conversion.clauses[env.conversion.active].ranked_context = nil
        elseif option == "emoji" and env.conversion then
            for _, clause in ipairs(env.conversion.clauses) do
                clause.filtered = false
            end
            Top.render(context)
        end
    end)
end

function Top.fini(env)
    env.option_connection:disconnect()
    sessions[env.session_id] = nil
    stock.fini(env)
end

local function session(context)
    return sessions[context:get_property("_kagiroi_bunsetsu_session")]
end

function Top.state(context)
    local env = session(context)
    return env and env.conversion
end

function Top.clear(context)
    local env = session(context)
    if env then env.conversion = nil end
end

local function choice_candidate(choice, seg, env)
    if not choice.entry then
        return Candidate("kagiroi", seg.start, seg._end, choice.text, choice.comment or "")
    end
    local candidate = Phrase(env.mem, "kagiroi_lex", seg.start, seg._end, choice.entry):toCandidate()
    return ShadowCandidate(candidate, "kagiroi", choice.text, choice.comment or "")
end

local function save_filtered(clause, translation)
    local previous = clause.candidates[clause.selected]
    local sources = {}
    for _, choice in ipairs(clause.unfiltered) do
        if choice.entry and not sources[choice.entry.text] then sources[choice.entry.text] = choice end
    end
    local candidates, seen = {}, {}
    for candidate in translation:iter() do
        if not seen[candidate.text] then
            seen[candidate.text] = true
            local genuine = candidate:get_genuine()
            local phrase = genuine:to_phrase()
            local source = phrase and sources[phrase.entry.text]
            candidates[#candidates + 1] = {
                text = candidate.text,
                comment = candidate.comment,
                source_text = genuine.text,
                entry = phrase and DictEntry(phrase.entry),
                left_id = source and source.left_id,
                right_id = source and source.right_id,
                route_words = source and source.text == candidate.text and source.route_words or nil,
            }
        end
    end
    clause.candidates, clause.selected, clause.filtered = candidates, 1, true
    if previous then
        for index, choice in ipairs(candidates) do
            if choice.text == previous.text and choice.source_text == previous.source_text then
                clause.selected = index
                return
            end
        end
        for index, choice in ipairs(candidates) do
            if choice.text == previous.text then
                clause.selected = index
                return
            end
        end
        for index, choice in ipairs(candidates) do
            if choice.source_text == previous.source_text then
                clause.selected = index
                return
            end
        end
    end
end

local function entry_ids(entry)
    if not entry then return nil end
    local _, left_id, right_id = string.match(entry.text, "(.+)|(-?%d+) (-?%d+)")
    if not left_id then return nil end
    return tonumber(left_id), tonumber(right_id)
end

local function matrix_cost(env, right_id, left_id)
    if not env.viterbi._get_matrix_cost then return nil end
    local cost = env.viterbi:_get_matrix_cost(right_id, left_id)
    if cost == math.huge then return nil end
    return cost
end

local function viterbi_supports_context(env)
    return type(env.viterbi) == "table"
        and type(env.viterbi._get_matrix_cost) == "function"
        and (type(env.viterbi._lookup) == "function"
            or (env.viterbi.lattice ~= nil and env.viterbi.eos ~= nil))
end

local function left_boundary_term(env, context, left_id)
    if context.at_start then
        local bos = matrix_cost(env, 0, left_id)
        local prefix_penalty = matrix_cost(env, -10, left_id)
        if not bos or not prefix_penalty then return nil end
        return bos + prefix_penalty
    end
    return matrix_cost(env, context.prev_right_id, left_id)
end

local function right_boundary_term(env, context, right_id)
    if context.at_end then
        local eos = matrix_cost(env, right_id, 0)
        local suffix_penalty = matrix_cost(env, right_id, -20)
        if not eos or not suffix_penalty then return nil end
        return eos + suffix_penalty
    end
    return matrix_cost(env, right_id, context.next_left_id)
end

local function route_history_discount(state, active, choice)
    local words, starts, ends, position = {}, {}, {}, 1
    for index, clause in ipairs(state.clauses) do
        local selected = index == active and choice or clause.candidates[clause.selected]
        local route = not clause.override and selected.route_words
        if route then
            for _, word in ipairs(route) do
                words[#words + 1] = word
                starts[position] = #words
                position = position + utf8.len(word.surface)
                ends[position - 1] = #words
            end
        else
            words[#words + 1] = { surface = clause.reading,
                candidate = clause.override or selected.text }
            position = position + utf8.len(clause.reading)
        end
    end
    local matches = {}
    for _, history in ipairs(state.histories or {}) do
        local first, last = starts[history.first], ends[history.last]
        if first and last and first <= last then
            local readings, texts, matches_route = {}, {}, true
            if history.route and #history.route ~= last - first + 1 then matches_route = false end
            for index = first, last do
                local word = words[index]
                readings[#readings + 1], texts[#texts + 1] = word.surface, word.candidate
                local saved = history.route and history.route[index - first + 1]
                if history.route and (not saved or saved.surface ~= word.surface
                    or saved.candidate ~= word.candidate or saved.left_id ~= word.left_id
                    or saved.right_id ~= word.right_id) then matches_route = false end
            end
            if matches_route and table.concat(readings) == history.reading
                and table.concat(texts) == history.text then
                matches[last] = matches[last] or {}
                matches[last][#matches[last] + 1] = {
                    first = first, bonus = lexical_history_bonus(history, utf8.len(state.reading)),
                }
            end
        end
    end
    local discounts = { [0] = 0 }
    for index in ipairs(words) do
        local best = discounts[index - 1]
        for _, match in ipairs(matches[index] or {}) do
            best = math.max(best, discounts[match.first - 1] + match.bonus)
        end
        discounts[index] = best
    end
    return discounts[#words]
end

local function uncorrected_contextual_score(choice, env, context)
    if not choice.own and not choice.route_words then return nil end
    local left_term = left_boundary_term(env, context, choice.left_id)
    if not left_term then return nil end
    local right_term = right_boundary_term(env, context, choice.right_id)
    if not right_term then return nil end
    if context.state and choice.route_words then
        if not choice.base_own then
            local own, previous = 0, nil
            for _, word in ipairs(choice.route_words) do
                if previous then
                    local connection = matrix_cost(env, previous.right_id, word.left_id)
                    if not connection then return nil end
                    own = own + connection
                end
                own, previous = own + word.wcost, word
            end
            choice.base_own = own
        end
        return choice.base_own + left_term + right_term
            - route_history_discount(context.state, context.index, choice)
    end
    return choice.own + left_term + right_term
end

local function whole_word_nodes(starting, length)
    if not starting then return {} end
    local nodes = {}
    for _, node in ipairs(starting[1] or {}) do
        if node._end == length and not node.route_words and not node.fallback then
            nodes[#nodes + 1] = node
        end
    end
    return nodes
end

local function whole_word_score(node, env, context)
    local candidate = { text = node.candidate, own = node.wcost, base_own = node.wcost,
        left_id = node.left_id, right_id = node.right_id, route_words = { node } }
    return uncorrected_contextual_score(candidate, env, context)
end

local function whole_word_scores(whole, env, context)
    local scores, best = {}, math.huge
    for _, node in ipairs(whole) do
        local score = whole_word_score(node, env, context)
        scores[#scores + 1] = score
        if score and score < best then best = score end
    end
    return scores, best
end

local function quality_anchor(env, context)
    if context.quality_anchor == nil then
        local clause = context.state and context.state.clauses[context.index]
        local starting = clause and clause.starting
        local reading = clause and clause.reading or ""
        local _, best = whole_word_scores(whole_word_nodes(starting, utf8.len(reading)), env, context)
        context.quality_anchor = best
    end
    return context.quality_anchor
end

local function quality_score(base, risk, whole)
    if whole == math.huge then return base end
    return base + math.max(0, risk - math.max(0, whole - base))
end

local function route_risk(words, env)
    local risk = 0
    for index = 2, #(words or {}) do
        local connection = matrix_cost(env, words[index - 1].right_id, words[index].left_id)
        if not connection then return nil end
        risk = risk + math.max(0, connection)
    end
    return risk
end

local function contextual_score(choice, env, context)
    local base = uncorrected_contextual_score(choice, env, context)
    if not base then return nil end
    local clause = context.state and context.state.clauses[context.index]
    if not clause or not clause.quality then return base end
    local whole = quality_anchor(env, context)
    local risk = 0
    if whole < math.huge then
        risk = choice.quality_risk
        if risk == nil then risk = route_risk(choice.route_words, env) end
        if risk == nil then return nil end
    end
    return quality_score(base, risk, whole)
end

local function starting_nodes(viterbi, length)
    local starting = {}
    for position = 1, length do
        for _, node in ipairs(viterbi.lattice[position] or {}) do
            local key = node.start
            starting[key] = starting[key] or {}
            node.dictionary_order = #starting[key] + 1
            starting[key][#starting[key] + 1] = node
        end
    end
    return starting
end

local function lexicon_entries(env, surface)
    local entries, histories = {}, nil
    for lex in env.viterbi:_lookup(surface) do
        if lex.learned then
            histories = histories or {}
            histories[#histories + 1] = {
                reading = surface, text = lex.candidate,
                commit_count = lex.commit_count, route = lex.route,
            }
        else
            entries[#entries + 1] = lex
        end
    end
    return entries, histories
end

local function dictionary_nodes(env, reading)
    local viterbi = env.viterbi
    local length = utf8.len(reading)
    if type(viterbi._lookup) ~= "function" then return starting_nodes(viterbi, length) end
    local offsets = {}
    for offset in utf8.codes(reading) do offsets[#offsets + 1] = offset end
    offsets[#offsets + 1] = #reading + 1
    local starting = { histories = {}, reading_length = length }
    for first = 1, length do
        local nodes = {}
        for last = first, length do
            local surface = reading:sub(offsets[first], offsets[last + 1] - 1)
            local entries, histories = lexicon_entries(env, surface)
            for order, lex in ipairs(entries) do
                nodes[#nodes + 1] = {
                    dictionary_order = order,
                    start = first, _end = last, surface = surface,
                    candidate = lex.candidate, left_id = lex.left_id, right_id = lex.right_id,
                    wcost = lex.cost,
                }
            end
            for _, history in ipairs(histories or {}) do
                history.first, history.last = first, last
                starting.histories[#starting.histories + 1] = history
            end
        end
        starting[first] = nodes
    end
    return starting
end

local function completion_costs(starting, length, env, context)
    local remaining, completions = {}, {}
    for position = length, 1, -1 do
        for _, node in ipairs(starting[position] or {}) do
            if node._end == length then
                remaining[node] = right_boundary_term(env, context, node.right_id)
            else
                local best, best_successor
                for _, successor in ipairs(starting[node._end + 1] or {}) do
                    local conn = matrix_cost(env, node.right_id, successor.left_id)
                    local tail = remaining[successor]
                    if conn and tail then
                        local cost = conn + successor.wcost + tail
                        if not best or cost <= best then
                            if not best or cost < best
                                or word_route_precedes(chain_words(successor, completions),
                                    chain_words(best_successor, completions)) then
                                best, best_successor = cost, successor
                            end
                        end
                    end
                end
                remaining[node], completions[node] = best, best_successor
            end
        end
    end
    return remaining, completions
end

local function ranked_path_enum(reading, env, context, stock_texts, starting)
    local length = utf8.len(reading)
    local remaining, completions = completion_costs(starting, length, env, context)
    local heap, cheapest_prefix = {}, {}
    local sequence = 0
    local function offer(node, text, first_left, own, left_term, incoming)
        local tail = remaining[node]
        if not tail then return end
        local prefixes = cheapest_prefix[node] or {}
        cheapest_prefix[node] = prefixes
        local key = text
        local score = left_term + own
        local previous = prefixes[key]
        local state = { node = node, prev = incoming }
        if previous then
            if score > previous.score then return end
            if score == previous.score
                and not word_route_precedes(prefix_words(state), prefix_words(previous)) then
                return
            end
        end
        state.score = score
        prefixes[key] = state
        sequence = sequence + 1
        heap_push(heap, {
            sequence = sequence,
            node = node, text = text, first_left_id = first_left,
            own = own, left_term = left_term, key = key, prefix = state,
            score = left_term + own + tail,
        }, completions)
    end
    for _, node in ipairs(starting[1] or {}) do
        local term = left_boundary_term(env, context, node.left_id)
        if term then
            offer(node, node.candidate, node.left_id, node.wcost, term)
        end
    end
    local results, seen = {}, {}
    while heap[1] and #results < kContextualDiscoveryLimit do
        local path = heap_pop(heap, completions)
        local node = path.node
        if cheapest_prefix[node][path.key] == path.prefix then
            if node._end == length then
                if not stock_texts[path.text] and not seen[path.text] then
                    seen[path.text] = true
                    results[#results + 1] = {
                        text = path.text, left_id = path.first_left_id,
                        right_id = node.right_id, own = path.own, score = path.score,
                    }
                end
            else
                for _, successor in ipairs(starting[node._end + 1] or {}) do
                    local conn = matrix_cost(env, node.right_id, successor.left_id)
                    if conn then
                        offer(successor, path.text .. successor.candidate, path.first_left_id,
                            path.own + conn + successor.wcost, path.left_term, path.prefix)
                    end
                end
            end
        end
    end
    return results
end

local function apply_enumerated_paths(candidates, reading, enumerated)
    for _, item in ipairs(enumerated) do
        local matched = false
        for _, choice in ipairs(candidates) do
            if choice.text == item.text and choice.left_id == item.left_id
                and choice.right_id == item.right_id then
                choice.own = item.own
                matched = true
                break
            end
        end
        if not matched then
            local entry = DictEntry()
            entry.text = item.text .. "|" .. item.left_id .. " " .. item.right_id
            entry.custom_code = reading .. " "
            candidates[#candidates + 1] = {
                text = item.text,
                comment = "",
                source_text = entry.text,
                entry = entry,
                left_id = item.left_id,
                right_id = item.right_id,
                own = item.own,
            }
        end
    end
end

local function route_words_of(incoming, node)
    local words, state = { node }, incoming
    while state and state.node do
        words[#words + 1] = state.node
        state = state.prev
    end
    local ordered = {}
    for index = #words, 1, -1 do
        local word = words[index]
        if word.route_words then
            for _, original in ipairs(word.route_words) do ordered[#ordered + 1] = original end
        else
            ordered[#ordered + 1] = word
        end
    end
    return ordered
end

local function exact_history_route(starting, history, matrix_cost)
    local words, own, position = {}, 0, 1
    for _, word in ipairs(history.route) do
        local word_length = utf8.len(word.surface)
        local node
        for _, candidate_node in ipairs(starting[position] or {}) do
            if candidate_node._end == position + word_length - 1
                and candidate_node.surface == word.surface
                and candidate_node.candidate == word.candidate
                and candidate_node.left_id == word.left_id
                and candidate_node.right_id == word.right_id then
                node = candidate_node
                break
            end
        end
        if not node then return nil end
        if words[#words] then
            local conn = matrix_cost(words[#words].right_id, node.left_id)
            if not conn then return nil end
            own = own + conn
        end
        own = own + node.wcost
        words[#words + 1] = node
        position = position + word_length
    end
    local reading, text = {}, {}
    for _, word in ipairs(words) do
        reading[#reading + 1] = word.surface
        text[#text + 1] = word.candidate
    end
    if table.concat(reading) ~= history.reading or table.concat(text) ~= history.text then return nil end
    return words, own
end



local function advance_route_patterns(previous, node, patterns)
    if not patterns or #patterns == 0 then return nil, "" end
    local progress, keys = {}, {}
    for index, pattern in ipairs(patterns) do
        local matched = previous and previous[index]
        if matched == nil then matched = pattern.words and 0 or "" end
        for _, word in ipairs(node.route_words or { node }) do
            if matched ~= false and word._end >= pattern.first and word.start <= pattern.last then
                if word.start < pattern.first or word._end > pattern.last then
                    matched = false
                elseif pattern.words then
                    local expected = pattern.words[matched + 1]
                    if expected and word.start == expected.start and word._end == expected._end
                        and word.surface == expected.surface and word.candidate == expected.candidate
                        and word.left_id == expected.left_id and word.right_id == expected.right_id then
                        matched = matched + 1
                    else matched = false end
                else
                    matched = matched .. word.candidate
                end
            end
        end
        progress[index] = matched
        keys[index] = matched == false and "x" or type(matched) == "number" and "p" .. matched
            or "t" .. escape_history_field(matched)
    end
    return progress, table.concat(keys, ";")
end

local function prune_frontier(frontier)
    if #frontier < 2 then return end
    local best, min_risk = frontier[1], frontier[1].risk
    for index = 2, #frontier do
        local candidate = frontier[index]
        if candidate.own < best.own or candidate.own == best.own and candidate.risk < best.risk then
            best = candidate
        end
        min_risk = math.min(min_risk, candidate.risk)
    end
    if best.risk == min_risk then
        for index = #frontier, 2, -1 do frontier[index] = nil end
        frontier[1] = best
        return
    end
    local ordered, retained = {}, {}
    for index in ipairs(frontier) do ordered[index] = index end
    table.sort(ordered, function(a, b)
        local left, right = frontier[a], frontier[b]
        if left.own ~= right.own then return left.own < right.own end
        if left.risk ~= right.risk then return left.risk < right.risk end
        return a < b
    end)
    local best_risk
    for _, index in ipairs(ordered) do
        local risk = frontier[index].risk
        if not best_risk or risk < best_risk then
            retained[index] = true
            best_risk = risk
        end
    end
    local count, original_count = 0, #frontier
    for index = 1, original_count do
        if retained[index] then
            count = count + 1
            frontier[count] = frontier[index]
        end
    end
    for index = count + 1, original_count do frontier[index] = nil end
end

local function quality_text_route_pairs(starting, length, text, matrix_cost)
    local has_whole_word = #whole_word_nodes(starting, length) > 0
    local function inner_risk(node)
        if not has_whole_word then return 0 end
        local risk, previous = 0, nil
        for _, word in ipairs(node.route_words or {}) do
            if previous then
                local connection = matrix_cost(previous.right_id, word.left_id)
                if not connection then return nil end
                risk = risk + math.max(0, connection)
            end
            previous = word
        end
        return risk
    end
    local states = { [0] = { { { offset = 0, own = 0, risk = 0 } } } }
    local pairs_by_key = {}
    local sequence = 0
    for position = 1, length do
        for _, node in ipairs(starting[position] or {}) do
            local node_states = {}
            if type(node.candidate) == "string" and node.candidate ~= "" then
                local intrinsic = inner_risk(node)
                if intrinsic then
                    for _, group in ipairs(states[position - 1] or {}) do
                        for _, incoming in ipairs(group) do
                            local from = incoming.offset + 1
                            if text:sub(from, from + #node.candidate - 1) == node.candidate then
                                local connection = 0
                                if incoming.first_left then
                                    connection = matrix_cost(incoming.node.right_id, node.left_id)
                                end
                                if connection then
                                    local own = incoming.own + connection + node.wcost
                                    local risk = incoming.risk + intrinsic
                                        + (has_whole_word and math.max(0, connection) or 0)
                                    local first_left = incoming.first_left or node.left_id
                                    local next_offset = from + #node.candidate - 1
                                    local progress, pattern_key = advance_route_patterns(incoming.pattern_progress,
                                        node, starting.route_patterns)
                                    if node._end == length then
                                        if next_offset == #text then
                                            local key = first_left .. " " .. node.right_id .. " " .. pattern_key
                                            local frontier = pairs_by_key[key] or {}
                                            pairs_by_key[key] = frontier
                                            sequence = sequence + 1
                                            frontier[#frontier + 1] = { left_id = first_left, right_id = node.right_id,
                                                own = own, risk = risk,
                                                words = route_words_of(incoming, node), order = sequence }
                                        end
                                    else
                                        local key = first_left .. " " .. next_offset .. " " .. pattern_key
                                        local frontier = node_states[key]
                                        if not frontier then
                                            frontier = {}
                                            node_states[key] = frontier
                                            states[node._end] = states[node._end] or {}
                                            states[node._end][#states[node._end] + 1] = frontier
                                        end
                                        frontier[#frontier + 1] = { node = node, first_left = first_left,
                                            offset = next_offset, own = own, risk = risk,
                                            prev = incoming, pattern_progress = progress }
                                    end
                                end
                            end
                        end
                    end
                end
            end
            for _, frontier in pairs(node_states) do prune_frontier(frontier) end
        end
        states[position - 1] = nil
    end
    local routes = {}
    for _, frontier in pairs(pairs_by_key) do
        prune_frontier(frontier)
        for _, route in ipairs(frontier) do routes[#routes + 1] = route end
    end
    table.sort(routes, function(a, b)
        if a.left_id ~= b.left_id then return a.left_id < b.left_id end
        if a.right_id ~= b.right_id then return a.right_id < b.right_id end
        return a.order < b.order
    end)
    return routes
end

local function attach_histories(starting, env)
    for _, history in ipairs(starting.histories or {}) do
        local span = {}
        for position = history.first, history.last do
            local nodes = {}
            for _, node in ipairs(starting[position] or {}) do
                if node._end <= history.last and not node.route_words and not node.fallback then
                    nodes[#nodes + 1] = {
                        start = position - history.first + 1, _end = node._end - history.first + 1,
                        surface = node.surface, candidate = node.candidate,
                        left_id = node.left_id, right_id = node.right_id, wcost = node.wcost,
                        dictionary_order = node.dictionary_order,
                    }
                end
            end
            span[position - history.first + 1] = nodes
        end
        local connection = function(right_id, left_id) return matrix_cost(env, right_id, left_id) end
        local routes
        if history.route then
            local words, own = exact_history_route(span, history, connection)
            routes = words and { { words = words, own = own,
                left_id = words[1].left_id, right_id = words[#words].right_id } } or {}
        else
            routes = quality_text_route_pairs(span, history.last - history.first + 1, history.text, connection)
        end
        for _, route in ipairs(routes) do
            local words = {}
            for _, word in ipairs(route.words) do
                words[#words + 1] = {
                    start = word.start + history.first - 1, _end = word._end + history.first - 1,
                    surface = word.surface, candidate = word.candidate,
                    left_id = word.left_id, right_id = word.right_id, wcost = word.wcost,
                    dictionary_order = word.dictionary_order,
                }
            end
            local nodes = starting[history.first]
            local bonus = lexical_history_bonus(history, starting.reading_length)
            nodes[#nodes + 1] = {
                start = history.first, _end = history.last,
                surface = history.reading, candidate = history.text,
                left_id = route.left_id, right_id = route.right_id,
                wcost = route.own - bonus, route_words = words,
            }
        end
    end
end

local function constrain_boundaries(starting, length, boundaries)
    local last = length
    for position = length, 1, -1 do
        if boundaries and boundaries[position] then last = position end
        local nodes = {}
        for _, node in ipairs(starting[position] or {}) do
            if node._end <= last then nodes[#nodes + 1] = node end
        end
        starting[position] = nodes
    end
end

local function add_fallback_nodes(starting, reading, boundaries)
    local characters = {}
    for _, codepoint in utf8.codes(reading) do characters[#characters + 1] = utf8.char(codepoint) end
    for position = #characters, 1, -1 do
        if #(starting[position] or {}) == 0 then
            local last = position
            local codepoint = utf8.codepoint(characters[position])
            local kana = codepoint >= 0x3040 and codepoint <= 0x30ff
            while last < #characters and not (boundaries and boundaries[last]) do
                local next_character = utf8.codepoint(characters[last + 1])
                local next_kana = next_character >= 0x3040 and next_character <= 0x30ff
                if kana ~= next_kana or #(starting[last + 1] or {}) > 0
                    and not starting[last + 1][1].fallback then break end
                last = last + 1
            end
            local surface = table.concat(characters, "", position, last)
            starting[position] = { { start = position, _end = last, surface = surface,
                candidate = surface, left_id = 0, right_id = 0,
                wcost = kUnknownWordCost, fallback = true } }
        end
    end
end

local function whole_reading_histories(starting)
    local whole = {}
    for _, history in ipairs(starting.histories or {}) do
        if history.first == 1 and history.last == starting.reading_length then
            whole[#whole + 1] = history
        end
    end
    return whole
end

local function ranked_path(reading, env, context, boundaries, fallback, dictionary_only)
    local length = utf8.len(reading)
    local starting = dictionary_nodes(env, reading)
    constrain_boundaries(starting, length, boundaries)
    if fallback then add_fallback_nodes(starting, reading, boundaries) end
    if not dictionary_only then
        starting.histories = whole_reading_histories(starting)
        attach_histories(starting, env)
    end
    local remaining, completions = completion_costs(starting, length, env, context)
    local best_node, best = nil, math.huge
    for _, node in ipairs(starting[1] or {}) do
        local left = left_boundary_term(env, context, node.left_id)
        local tail = remaining[node]
        if left and tail then
            local score = left + node.wcost + tail
            if score <= best then
                if not best_node or score < best
                    or word_route_precedes(chain_words(node, completions),
                        chain_words(best_node, completions)) then
                    best_node, best = node, score
                end
            end
        end
    end
    if not best_node then return nil, best end
    return chain_words(best_node, completions), best
end

local function pair_choices(rows, left_id, right_id)
    local right_rows = rows[left_id]
    if not right_rows then
        right_rows = {}
        rows[left_id] = right_rows
    end
    local choices = right_rows[right_id]
    if not choices then
        choices = {}
        right_rows[right_id] = choices
    end
    return choices
end

local function index_choice_pairs(candidates)
    local rows_by_text, texts = {}, {}
    for _, choice in ipairs(candidates) do
        local left_id, right_id = entry_ids(choice.entry)
        choice.left_id, choice.right_id = left_id, right_id
        local rows = rows_by_text[choice.text]
        if not rows then
            rows = {}
            rows_by_text[choice.text] = rows
            texts[#texts + 1] = choice.text
        end
        if left_id and right_id then
            local choices = pair_choices(rows, left_id, right_id)
            choices[#choices + 1] = choice
        end
    end
    return rows_by_text, texts
end

local function append_route_choice(choices, candidates, text, reading, route)
    local entry = DictEntry()
    entry.text = text .. "|" .. route.left_id .. " " .. route.right_id
    entry.custom_code = reading .. " "
    local choice = {
        text = text,
        comment = "",
        source_text = entry.text,
        entry = entry,
        left_id = route.left_id,
        right_id = route.right_id,
        own = route.own,
        route_words = route.words,
    }
    choices[#choices + 1] = choice
    candidates[#candidates + 1] = choice
    return choice
end

local function quality_attach_pair_routes(candidates, reading, env, starting, route_cache)
    local length = utf8.len(reading)
    local has_whole_word = #whole_word_nodes(starting, length) > 0
    local rows_by_text, texts = index_choice_pairs(candidates)
    local choice_indexes = {}
    for _, text in ipairs(texts) do
        local rows = rows_by_text[text]
        local route_pairs = route_cache[text]
        if not route_pairs then
            route_pairs = quality_text_route_pairs(starting, length, text,
                function(right_id, left_id) return matrix_cost(env, right_id, left_id) end)
            route_cache[text] = route_pairs
        end
        for _, route in ipairs(route_pairs) do
            local choices = pair_choices(rows, route.left_id, route.right_id)
            local first = choices[1]
            local match_first = first and (not first.route_words
                or not has_whole_word and not first.path_hint and not starting.route_patterns)
            local index, signature, position
            if match_first then
                position = 1
            else
                index = choice_indexes[choices]
                if not index then
                    index = { signatures = {}, unassigned = 1 }
                    choice_indexes[choices] = index
                    for choice_position, choice in ipairs(choices) do
                        local match_pair = not has_whole_word and not choice.path_hint and not starting.route_patterns
                        if match_pair then
                            index.first_pair = index.first_pair or choice_position
                        elseif choice.route_words then
                            local key = route_signature(choice.route_words)
                            index.signatures[key] = index.signatures[key] or choice_position
                        end
                    end
                end
                while choices[index.unassigned] and choices[index.unassigned].route_words do
                    index.unassigned = index.unassigned + 1
                end
                signature = route_signature(route.words)
                position = math.min(index.first_pair or math.huge,
                    index.signatures[signature] or math.huge,
                    choices[index.unassigned] and index.unassigned or math.huge)
            end
            local choice = choices[position]
            if choice then
                choice.own, choice.base_own = route.own, nil
                choice.route_words, choice.quality_risk = route.words, route.risk
            else
                choice = append_route_choice(choices, candidates, text, reading, route)
                choice.quality_risk = route.risk
                position = #choices
            end
            if index and position ~= index.first_pair then
                index.signatures[signature] = math.min(index.signatures[signature] or math.huge, position)
            end
        end
    end
end



local function plain_text_route_pairs(starting, length, text, matrix_cost)
    local states = { [0] = { { offset = 0 } } }
    local pairs_by_key, states_by_node = {}, {}
    local sequence = 0
    for position = 1, length do
        for _, node in ipairs(starting[position] or {}) do
            if type(node.candidate) == "string" and node.candidate ~= "" then
                for _, incoming in ipairs(states[position - 1] or {}) do
                    local from = incoming.offset + 1
                    if text:sub(from, from + #node.candidate - 1) == node.candidate then
                        local own, first_left
                        if incoming.first_left then
                            local conn = matrix_cost(incoming.node.right_id, node.left_id)
                            if conn then
                                own, first_left = incoming.own + conn
                                    + node.wcost, incoming.first_left
                            end
                        else
                            own, first_left = node.wcost, node.left_id
                        end
                        if own then
                            local next_offset = from + #node.candidate - 1
                            local progress, pattern_key = advance_route_patterns(incoming.pattern_progress,
                                node, starting.route_patterns)
                            if node._end == length then
                                if next_offset == #text then
                                    local key = first_left .. " " .. node.right_id .. " " .. pattern_key
                                    local current = pairs_by_key[key]
                                    if not current or own < current.own then
                                        sequence = sequence + 1
                                        pairs_by_key[key] = { left_id = first_left, right_id = node.right_id,
                                            own = own, words = route_words_of(incoming, node), order = sequence }
                                    end
                                end
                            else
                                local bucket = states[node._end] or {}
                                local node_states = states_by_node[node] or {}
                                states_by_node[node] = node_states
                                local key = first_left .. " " .. next_offset .. " " .. pattern_key
                                local existing = node_states[key]
                                if existing then
                                    if own < existing.own then
                                        existing.own, existing.prev = own, incoming
                                    end
                                else
                                    local state = {
                                        node = node,
                                        first_left = first_left,
                                        offset = next_offset,
                                        own = own, prev = incoming, pattern_progress = progress,
                                    }
                                    bucket[#bucket + 1] = state
                                    node_states[key] = state
                                end
                                states[node._end] = bucket
                            end
                        end
                    end
                end
            end
        end
    end
    local routes = {}
    for _, route in pairs(pairs_by_key) do routes[#routes + 1] = route end
    table.sort(routes, function(a, b)
        if a.left_id ~= b.left_id then return a.left_id < b.left_id end
        if a.right_id ~= b.right_id then return a.right_id < b.right_id end
        return a.order < b.order
    end)
    return routes
end

local function plain_attach_pair_routes(candidates, reading, env, starting, route_cache)
    local length = utf8.len(reading)
    local rows_by_text, texts = index_choice_pairs(candidates)
    for _, text in ipairs(texts) do
        local rows = rows_by_text[text]
        local route_pairs = route_cache[text]
        if not route_pairs then
            route_pairs = plain_text_route_pairs(starting, length, text,
                function(right_id, left_id) return matrix_cost(env, right_id, left_id) end)
            route_cache[text] = route_pairs
        end
        for _, route in ipairs(route_pairs) do
            local choices = pair_choices(rows, route.left_id, route.right_id)
            local matched = false
            for _, choice in ipairs(choices) do
                local match_pair = not choice.path_hint and not starting.route_patterns
                if not choice.route_words or match_pair
                    or route_signature(choice.route_words) == route_signature(route.words) then
                    choice.own, choice.base_own = route.own, nil
                    choice.route_words = route.words
                    matched = true
                    break
                end
            end
            if not matched then
                local entry = DictEntry()
                entry.text = text .. "|" .. route.left_id .. " " .. route.right_id
                entry.custom_code = reading .. " "
                local choice = {
                    text = text,
                    comment = "",
                    source_text = entry.text,
                    entry = entry,
                    left_id = route.left_id,
                    right_id = route.right_id,
                    own = route.own,
                    route_words = route.words,
                }
                choices[#choices + 1] = choice
                candidates[#candidates + 1] = choice
            end
        end
    end
end

local function strip_plain_attachment(candidates, keep)
    for index = #candidates, keep + 1, -1 do table.remove(candidates, index) end
    for _, choice in ipairs(candidates) do
        choice.own, choice.base_own, choice.route_words, choice.quality_risk = nil, nil, nil, nil
    end
end

local function content_whole_nodes(whole, reading, length, env)
    local katakana = env.hira2kata_opencc and env.hira2kata_opencc():convert(reading) or nil
    local content = {}
    for _, node in ipairs(whole) do
        if node.candidate ~= reading and node.candidate ~= katakana
            and utf8.len(node.candidate) <= length then
            content[#content + 1] = node
        end
    end
    return content
end

local function quality_flip_present(candidates, whole, env, context)
    local scores, best = whole_word_scores(whole, env, context)
    if best == math.huge then return false end
    for _, choice in ipairs(candidates) do
        local words = choice.route_words
        if words and #words >= 2 then
            local base = uncorrected_contextual_score(choice, env, context)
            local risk = base and route_risk(words, env)
            if base and risk and risk > 0 then
                local corrected = quality_score(base, risk, best)
                for _, score in ipairs(scores) do
                    if score and base < score and corrected > score then return true end
                end
            end
        end
    end
    return false
end

local function quality_gate_decision(candidates, reading, env, context, starting, route_cache)
    if not (context.at_start and context.at_end) then return false end
    local length = utf8.len(reading)
    local content = content_whole_nodes(whole_word_nodes(starting, length), reading, length, env)
    if #content == 0 then return false end
    local keep = #candidates
    plain_attach_pair_routes(candidates, reading, env, starting, route_cache)
    if not quality_flip_present(candidates, content, env, context) then return false, true end
    strip_plain_attachment(candidates, keep)
    return true, false
end

local function attach_contextual_costs(candidates, reading, env, context)
    local stock_texts = {}
    for _, choice in ipairs(candidates) do stock_texts[choice.text] = true end
    candidates.stock_texts = stock_texts
    local starting = dictionary_nodes(env, reading)
    attach_histories(starting, env)
    context = context or { at_start = true, at_end = true }
    local route_cache = {}
    local gated, plain_attached = quality_gate_decision(candidates, reading, env, context, starting, route_cache)
    if gated then
        route_cache = {}
        quality_attach_pair_routes(candidates, reading, env, starting, route_cache)
    elseif not plain_attached then
        plain_attach_pair_routes(candidates, reading, env, starting, route_cache)
    end
    for index = #candidates, 1, -1 do
        local choice = candidates[index]
        local kanji = choice.left_id == kKanjiCandidateId and choice.right_id == kKanjiCandidateId
        if choice.entry and not choice.route_words and not kanji then table.remove(candidates, index) end
    end
    local enumerated = ranked_path_enum(reading, env, context, stock_texts, starting)
    if gated then
        for _, node in ipairs(whole_word_nodes(starting, utf8.len(reading))) do
            enumerated[#enumerated + 1] = { text = node.candidate, left_id = node.left_id,
                right_id = node.right_id, own = node.wcost }
        end
    end
    if enumerated then
        apply_enumerated_paths(candidates, reading, enumerated)
        if gated then quality_attach_pair_routes(candidates, reading, env, starting, route_cache)
        else plain_attach_pair_routes(candidates, reading, env, starting, route_cache) end
    end
    candidates.quality_gate = gated
    return starting, route_cache
end

local function connection_key(context)
    if not context then return "unavailable" end
    return table.concat({ tostring(context.at_start), tostring(context.at_end),
        context.prev_right_id or 0, context.next_left_id or 0 }, ":")
end

local function context_key(context)
    local parts = { connection_key(context) }
    if context and context.state then
        for index, clause in ipairs(context.state.clauses) do
            if index ~= context.index then
                local choice = clause.candidates[clause.selected]
                parts[#parts + 1] = escape_history_field(clause.reading)
                    .. ":" .. escape_history_field(clause.override or choice.text)
                    .. history_suffix("c", not clause.override and choice.route_words or nil)
            end
        end
    end
    return table.concat(parts, ":")
end

local function reorder_contextual(clause, env, context)
    local key = connection_key(context)
    clause.discovered_contexts = clause.discovered_contexts or {}
    if context and not clause.discovered_contexts[key] then
        local enumerated = ranked_path_enum(clause.reading, env, context, clause.stock_texts, clause.starting)
        apply_enumerated_paths(clause.unfiltered, clause.reading, enumerated)
        if clause.quality then quality_attach_pair_routes(clause.unfiltered, clause.reading, env, clause.starting, clause.route_cache)
        else plain_attach_pair_routes(clause.unfiltered, clause.reading, env, clause.starting, clause.route_cache) end
    end
    clause.discovered_contexts[key] = true
    local scored, unscored = {}, {}
    for _, choice in ipairs(clause.unfiltered) do
        if not choice.order then
            clause.next_order = (clause.next_order or 0) + 1
            choice.order = clause.next_order
        end
        local score = context and contextual_score(choice, env, context)
        if score then
            scored[#scored + 1] = { choice = choice, score = score, position = choice.order }
        else
            unscored[#unscored + 1] = choice
        end
    end
    if #scored == 0 then return end
    local preserve_filtered_choice = clause.candidates ~= clause.unfiltered
    local chosen = clause.candidates[clause.selected]
    local chosen_entry_text = chosen.entry and chosen.entry.text
    table.sort(scored, function(a, b)
        if a.score ~= b.score then return a.score < b.score end
        return a.position < b.position
    end)
    local reordered = {}
    for _, item in ipairs(scored) do reordered[#reordered + 1] = item.choice end
    for _, choice in ipairs(unscored) do reordered[#reordered + 1] = choice end
    clause.unfiltered = reordered
    clause.filtered = nil
    if preserve_filtered_choice then return end
    clause.candidates = reordered
    for index, choice in ipairs(reordered) do
        if choice == chosen or (choice.text == chosen.text
            and (choice.entry and choice.entry.text) == chosen_entry_text) then
            clause.selected = index
            return
        end
    end
    clause.selected = 1
end

local function add_route_hint(candidates, reading, words, env)
    local left_id, right_id = words[1].left_id, words[#words].right_id
    local signature = route_signature(words)
    for _, choice in ipairs(candidates) do
        if choice.left_id == left_id and choice.right_id == right_id
            and choice.route_words and route_signature(choice.route_words) == signature then return end
    end
    local own, texts = 0, {}
    for index, word in ipairs(words) do
        if index > 1 then own = own + matrix_cost(env, words[index - 1].right_id, word.left_id) end
        own = own + word.wcost
        texts[#texts + 1] = word.candidate
    end
    local text = table.concat(texts)
    local entry = DictEntry()
    entry.text = text .. "|" .. left_id .. " " .. right_id
    entry.custom_code = reading .. " "
    candidates[#candidates + 1] = { text = text, comment = "", entry = entry,
        left_id = left_id, right_id = right_id, own = own, route_words = words, path_hint = true }
end

local function new_clause(reading, env, context, path_spec)
    local seg = Segment(0, #reading)
    -- The kagiroi_kanji script_translator only queries segments carrying the kagiroi tag (librime script_translator.cc)
    seg.tags = Set({ env.tag, "kagiroi" })
    local candidates, seen = {}, {}
    env.viterbi:analyze(reading)
    local has_dictionary_path = env.viterbi:best_n()() ~= nil
    local katakana = env.hira2kata_opencc():convert(reading)
    local function collect(translator)
        local iter = coroutine.wrap(function() translator(reading, seg, env) end)
        for candidate in iter do
            if candidate._end == #reading and not seen[candidate.text] then
                local phrase = candidate:get_genuine():to_phrase()
                local dummy = not has_dictionary_path and phrase
                    and (candidate.text == reading or candidate.text == katakana)
                if not dummy then
                    seen[candidate.text] = true
                    candidates[#candidates + 1] = {
                        text = candidate.text,
                        comment = candidate.comment,
                        entry = phrase and DictEntry(phrase.entry),
                    }
                end
            end
        end
    end
    collect(stock.func)
    collect(variants.func)
    if path_spec and path_spec.text then
        local matched = false
        for _, choice in ipairs(candidates) do
            local left_id, right_id = entry_ids(choice.entry)
            if choice.text == path_spec.text and left_id == path_spec.left_id
                and right_id == path_spec.right_id then matched = true break end
        end
        if not matched then
            local entry = DictEntry()
            entry.text = path_spec.text .. "|" .. path_spec.left_id .. " " .. path_spec.right_id
            entry.custom_code = reading .. " "
            candidates[#candidates + 1] = { text = path_spec.text, comment = "", entry = entry }
        end
    end
    if #candidates == 0 then candidates[1] = { text = reading } end
    local clause = { reading = reading, unfiltered = candidates, candidates = candidates, selected = 1 }
    if viterbi_supports_context(env) then
        clause.starting, clause.route_cache = attach_contextual_costs(clause.unfiltered, reading, env, context)
        clause.quality = clause.unfiltered.quality_gate == true
        if #candidates == 0 then candidates[1] = { text = reading } end
        clause.own_attached = true
        clause.stock_texts = clause.unfiltered.stock_texts
        if path_spec and path_spec.words then add_route_hint(candidates, reading, path_spec.words, env) end
        clause.discovered_contexts = { [connection_key(context or { at_start = true, at_end = true })] = true }
        if path_spec and path_spec.text then
            local signature = path_spec.words and route_signature(path_spec.words)
            for index, choice in ipairs(clause.unfiltered) do
                if choice.text == path_spec.text and choice.left_id == path_spec.left_id
                    and choice.right_id == path_spec.right_id
                    and (not signature or choice.route_words and route_signature(choice.route_words) == signature) then
                    clause.selected = index
                    break
                end
            end
        end
    end
    return clause
end

local function is_kana(codepoint)
    return codepoint >= 0x3040 and codepoint <= 0x30ff
end

local function best_path_nodes(viterbi)
    local nodes = {}
    local cur = viterbi.eos
    while cur and cur.type ~= "bos" do
        nodes[#nodes + 1] = cur
        local column = viterbi.lattice[cur.pre_index_col]
        cur = column and column[cur.pre_index_row] or nil
    end
    if not cur then return nil end
    local path = {}
    for i = #nodes, 2, -1 do path[#path + 1] = nodes[i] end
    return path
end

local function boundary_histories(env, reading)
    local histories = {}
    local mem = env.mem
    if not (mem and mem.user_lookup and mem.iter_user) then return histories end
    mem:user_lookup(reading .. " \t", true)
    for entry in mem:iter_user() do
        local prefix = reading .. "|" .. kHistoryIds .. kBoundaryMarker
        local encoded = entry.custom_code == reading .. " " and entry.text:sub(1, #prefix) == prefix
            and entry.text:sub(#prefix + 1):match("^[%d,]+$")
        if encoded and not encoded:find(",,", 1, true)
            and encoded:sub(1, 1) ~= "," and encoded:sub(-1) ~= "," then
            local boundaries, position, valid = {}, 0, true
            for size in encoded:gmatch("%d+") do
                local length = math.tointeger(size)
                if not length or length <= 0 then valid = false break end
                position = position + length
                boundaries[position] = true
            end
            if valid and position == utf8.len(reading) then
                histories[#histories + 1] = { boundaries = boundaries,
                    commit_count = entry.commit_count or 1 }
            end
        end
    end
    return histories
end

local function split_via_path(reading, env, context, all_reading)
    if not segmenter_loaded then return nil end
    local path, score, boundaries
    if env.viterbi.query_dict then
        path, score = ranked_path(reading, env, context, nil, all_reading)
        if all_reading and path then
            for _, history in ipairs(boundary_histories(env, reading)) do
                local alternative, cost = ranked_path(reading, env, context, history.boundaries, true)
                if alternative and cost <= score then
                    path, score, boundaries = alternative, cost, history.boundaries
                end
                local dictionary_path, dictionary_cost = ranked_path(reading, env, context, history.boundaries, true, true)
                local boundary_score = dictionary_cost and dictionary_cost - history_bonus(history.commit_count)
                if dictionary_path and boundary_score <= score then
                    path, score, boundaries = dictionary_path, boundary_score, history.boundaries
                end
            end
        end
    else path = best_path_nodes(env.viterbi) end
    if not path or #path == 0 then return nil end
    local specs = {}
    local covered = 0
    local current = {}
    for i, node in ipairs(path) do
        current[#current + 1] = node
        covered = covered + #node.surface
        local next_node = path[i + 1]
        local at_boundary = boundaries and boundaries[node._end]
            or not boundaries and (not next_node or node.fallback or next_node.fallback
                or segmenter.is_boundary_internal(node.right_id, next_node.left_id))
        if at_boundary then
            specs[#specs + 1] = current
            current = {}
        end
    end
    if #current > 0 or covered ~= #reading then return nil end
    local mapped = {}
    for _, group in ipairs(specs) do
        local texts = {}
        local spec = { reading = "", words = group }
        if not group[1].fallback then spec.left_id = group[1].left_id end
        mapped[#mapped + 1] = spec
        for _, node in ipairs(group) do
            texts[#texts + 1] = node.candidate
            spec.reading = spec.reading .. node.surface
            spec.right_id = node.right_id
            if node.fallback then spec.left_id = nil end
        end
        spec.text = table.concat(texts)
    end
    return mapped
end

local function clause_context(state, index)
    local clause = state.clauses[index]
    if not clause then return nil end
    local context = {
        at_start = index == 1,
        at_end = index == #state.clauses,
        prev_right_id = 0,
        next_left_id = 0,
        state = state, index = index,
    }
    local prev = state.clauses[index - 1]
    local next_clause = state.clauses[index + 1]
    if prev then
        local left_id, right_id = entry_ids(prev.candidates[prev.selected].entry)
        if not right_id then return nil end
        context.prev_right_id = right_id
    end
    if next_clause then
        local left_id = entry_ids(next_clause.candidates[next_clause.selected].entry)
        if not left_id then return nil end
        context.next_left_id = left_id
    end
    return context
end

local function selected_ids(clause)
    return entry_ids(clause.candidates[clause.selected].entry)
end

local function collect_filtered(context, state, index, retained_order)
    local clause = state.clauses[index]
    state.active = index
    state.active_start, state.active_end = 0, #clause.reading
    state.window_start = 0
    state.collecting = true
    context.input = ""
    context.input = clause.reading
    local segment = context.composition:back()
    if segment then segment:get_candidate_at(0) end
    state.collecting = false
    if retained_order then
        local positions = {}
        for position, choice in ipairs(retained_order) do positions[choice.text] = position end
        for position, choice in ipairs(clause.candidates) do
            positions[choice.text] = positions[choice.text] or #retained_order + position
        end
        local selected = clause.candidates[clause.selected]
        table.sort(clause.candidates, function(a, b) return positions[a.text] < positions[b.text] end)
        for position, choice in ipairs(clause.candidates) do
            if choice == selected then clause.selected = position break end
        end
    end
end

local function settle_contextual(context, state, env, retained_clause)
    local queue, queued = {}, {}
    local function enqueue(index)
        if state.clauses[index] and not queued[index] then
            queue[#queue + 1] = index
            queued[index] = true
        end
    end
    for index in ipairs(state.clauses) do enqueue(index) end
    local cursor = 1
    while cursor <= #queue do
        local index = queue[cursor]
        cursor = cursor + 1
        queued[index] = nil
        local clause = state.clauses[index]
        local score_context = state.contextual and clause.own_attached and clause_context(state, index) or nil
        local key = context_key(score_context)
        local select_first = state.first_choices and state.first_choices[index]
        local before_left, before_right = selected_ids(clause)
        local before_choice = clause.candidates[clause.selected]
        local before_route = history_suffix("c", before_choice.route_words)
        if not clause.filtered or clause.ranked_context ~= key then
            local retained_order = clause == retained_clause and clause.candidates
            if state.contextual and clause.own_attached then reorder_contextual(clause, env, score_context) end
            collect_filtered(context, state, index, retained_order)
            clause.ranked_context = key
        end
        if select_first then
            if score_context then
                local first_score = contextual_score(clause.candidates[1], env, score_context)
                local chosen_score = contextual_score(clause.candidates[clause.selected], env, score_context)
                if first_score and (not chosen_score or first_score < chosen_score) then clause.selected = 1 end
            else
                clause.selected = 1
            end
        end
        local after_left, after_right = selected_ids(clause)
        if before_left ~= after_left then enqueue(index - 1) end
        if before_right ~= after_right then enqueue(index + 1) end
        local after_choice = clause.candidates[clause.selected]
        if before_choice.text ~= after_choice.text or before_route ~= history_suffix("c", after_choice.route_words) then
            for other in ipairs(state.clauses) do if other ~= index then enqueue(other) end end
        end
    end
    state.first_choices = nil
end

local function split(reading, env)
    local specs, clauses = {}, {}
    local contextual = false
    local position = 1
    if type(env.viterbi._lookup) == "function" and env.viterbi.query_dict then
        local mapped = split_via_path(reading, env, { at_start = true, at_end = true }, true)
        if mapped then
            specs, contextual = mapped, true
            position = #reading + 1
        end
    end
    while position <= #reading do
        local kana = is_kana(utf8.codepoint(reading, position))
        local run_end = position
        for offset, codepoint in utf8.codes(reading:sub(position)) do
            if is_kana(codepoint) ~= kana then break end
            run_end = position + offset - 1 + #utf8.char(codepoint)
        end
        local remaining = reading:sub(position, run_end - 1)
        if kana then
            if type(env.viterbi._lookup) ~= "function" or not env.viterbi.query_dict then
                env.viterbi:analyze(remaining)
            end
            if viterbi_supports_context(env) then
                local mapped = split_via_path(remaining, env, {
                    at_start = position == 1, at_end = run_end > #reading,
                    prev_right_id = 0, next_left_id = 0,
                })
                if mapped then
                    contextual = true
                    for _, spec in ipairs(mapped) do specs[#specs + 1] = spec end
                    goto continue_run
                end
            end
        end
        while remaining ~= "" do
            local prefix = remaining
            if kana and not viterbi_supports_context(env) then
                env.viterbi:analyze(remaining)
                local lex = env.viterbi:best_n_prefix()()
                if lex and lex.surface ~= "" then prefix = lex.surface end
            end
            specs[#specs + 1] = { reading = prefix }
            remaining = remaining:sub(#prefix + 1)
        end
        ::continue_run::
        position = run_end
    end
    for index, spec in ipairs(specs) do
        local context = {
            at_start = index == 1, at_end = index == #specs,
            prev_right_id = specs[index - 1] and specs[index - 1].right_id or 0,
            next_left_id = specs[index + 1] and specs[index + 1].left_id or 0,
        }
        clauses[#clauses + 1] = new_clause(spec.reading, env, context, spec.left_id and spec or nil)
    end
    return clauses, contextual
end

local function prepare_route_patterns(state, env)
    local first = 1
    for _, clause in ipairs(state.clauses) do
        local last = first + utf8.len(clause.reading) - 1
        local patterns, seen = {}, {}
        for _, history in ipairs(state.histories or {}) do
            if history.first <= last and history.last >= first then
                local pattern = { first = math.max(first, history.first) - first + 1,
                    last = math.min(last, history.last) - first + 1 }
                local valid = true
                if history.route then
                    pattern.words = {}
                    local position = history.first
                    for _, word in ipairs(history.route) do
                        local word_end = position + utf8.len(word.surface) - 1
                        if position <= last and word_end >= first then
                            if position < first or word_end > last then valid = false break end
                            pattern.words[#pattern.words + 1] = {
                                start = position - first + 1, _end = word_end - first + 1,
                                surface = word.surface, candidate = word.candidate,
                                left_id = word.left_id, right_id = word.right_id,
                            }
                        end
                        position = word_end + 1
                    end
                end
                local signature = pattern.first .. ":" .. pattern.last
                    .. history_suffix("c", pattern.words)
                if valid and not seen[signature] then
                    seen[signature] = true
                    patterns[#patterns + 1] = pattern
                end
            end
        end
        if clause.starting then
            clause.starting.route_patterns = #patterns > 0 and patterns or nil
            clause.route_cache = {}
            if clause.quality then quality_attach_pair_routes(clause.unfiltered, clause.reading, env, clause.starting, clause.route_cache)
            else plain_attach_pair_routes(clause.unfiltered, clause.reading, env, clause.starting, clause.route_cache) end
            clause.filtered, clause.ranked_context = nil, nil
        end
        first = last + 1
    end
end

function Top.start(context, reading, katakana)
    local env = session(context)
    local clauses, contextual
    if katakana then
        clauses = { new_clause(reading, env) }
        contextual = clauses[1].own_attached == true
    else
        clauses, contextual = split(reading, env)
    end
    if katakana then clauses[1].override = katakana end
    env.conversion = { reading = reading, clauses = clauses, active = 1,
        henkan = katakana ~= nil, contextual = contextual,
        histories = contextual and dictionary_nodes(env, reading).histories or {} }
    if contextual then
        prepare_route_patterns(env.conversion, env)
        env.conversion.first_choices = {}
        for index in ipairs(clauses) do env.conversion.first_choices[index] = true end
    end
    Top.render(context)
    return env.conversion
end

function Top.sync(context)
    local state = Top.state(context)
    if not state or context:get_option("_kagiroi_hide_candidates") then return end
    local segment = context.composition:back()
    if segment and context:has_menu() then
        local clause = state.clauses[state.active]
        local selected = state.window_start + segment.selected_index + 1
        if selected ~= clause.selected then
            clause.selected = selected
            Top.render(context, clause)
        end
    end
end

function Top.display(context)
    Top.sync(context)
    local state = Top.state(context)
    local parts = {}
    for _, clause in ipairs(state.clauses) do
        parts[#parts + 1] = clause.override or clause.candidates[clause.selected].text
    end
    return table.concat(parts)
end

function Top.render(context, retained_clause)
    local state = Top.state(context)
    local active_index = state.active
    settle_contextual(context, state, session(context), retained_clause)
    state.active = active_index
    local hidden = context:get_option("_kagiroi_hide_candidates")
    local prefix, suffix = {}, {}
    for index, clause in ipairs(state.clauses) do
        local text = clause.override or clause.candidates[clause.selected].text
        if index < state.active then prefix[#prefix + 1] = text end
        if index > state.active then suffix[#suffix + 1] = text end
    end
    local clause = state.clauses[state.active]
    local active = hidden and (clause.override or clause.candidates[clause.selected].text) or clause.reading
    state.active_start = #table.concat(prefix)
    state.active_end = state.active_start + #active
    state.layout = table.concat(prefix) .. active .. table.concat(suffix)
    state.window_start = context:get_option("_kagiroi_expand_candidates") and 0
        or math.floor((clause.selected - 1) / 10) * 10
    -- The candidate gate numbers pages over the final display order, so it
    -- must know how many candidates this window skipped.
    context:set_property("_kagiroi_page_offset", tostring(state.window_start))
    context.input = ""
    context.input = state.layout
    local segment = context.composition:back()
    if not hidden and segment and context:has_menu() then
        local index = clause.selected - state.window_start - 1
        if type(context.highlight) == "function" then context:highlight(index)
        else segment.selected_index = index end
    end
end

function Top.move(context, direction)
    Top.sync(context)
    local state = Top.state(context)
    local target = math.max(1, math.min(#state.clauses, state.active + direction))
    if target ~= state.active then
        state.active = target
        -- A successful move with the list open closes it, clears the
        -- expansion and returns to the hidden conversion; a move blocked at
        -- an end keeps the list, expansion, selection and state
        -- (dotfiles/rime/SPEC.md, "文節移動").
        if not context:get_option("_kagiroi_hide_candidates") then
            context:set_option("_kagiroi_expand_candidates", false)
            context:set_option("_kagiroi_hide_candidates", true)
        end
    end
    Top.render(context)
end

function Top.resize(context, direction)
    Top.sync(context)
    local state = Top.state(context)
    local index = state.active
    local left, right = state.clauses[index], state.clauses[index + 1]
    local left_reading, right_reading = left.reading, right and right.reading or ""
    if direction < 0 then
        if utf8.len(left_reading) == 1 then return end
        local last = utf8.offset(left_reading, -1)
        right_reading = left_reading:sub(last) .. right_reading
        left_reading = left_reading:sub(1, last - 1)
    else
        if not right then return end
        local second = utf8.offset(right_reading, 2) or (#right_reading + 1)
        left_reading = left_reading .. right_reading:sub(1, second - 1)
        right_reading = right_reading:sub(second)
    end
    local env = session(context)
    local left_context = {
        at_start = index == 1,
        at_end = index == #state.clauses or (index + 1 == #state.clauses and right_reading == ""),
        prev_right_id = 0, next_left_id = 0,
    }
    local right_reshaped = right_reading ~= ""
    local right_context = {
        at_start = false, at_end = index + 1 >= #state.clauses,
        prev_right_id = 0, next_left_id = 0,
    }
    local before = state.clauses[index - 1]
    local after = state.clauses[index + (right and 2 or 1)]
    if before then
        local _, right_id = entry_ids(before.candidates[before.selected].entry)
        left_context.prev_right_id = right_id or 0
    end
    if after then right_context.next_left_id = entry_ids(after.candidates[after.selected].entry) or 0 end

    state.clauses[index] = new_clause(left_reading, env, left_context)
    if right_reading == "" then table.remove(state.clauses, index + 1)
    elseif right then state.clauses[index + 1] = new_clause(right_reading, env, right_context)
    else table.insert(state.clauses, index + 1, new_clause(right_reading, env, right_context)) end
    state.henkan = false
    if state.contextual then prepare_route_patterns(state, env) end
    state.first_choices = { [index] = true }
    if right_reshaped then state.first_choices[index + 1] = true end
    -- A boundary that actually moved closes a visible list and clears its
    -- expansion; the hidden conversion keeps its visibility, and an
    -- unchanged boundary keeps everything (dotfiles/rime/SPEC.md,
    -- "境界変更").
    if not context:get_option("_kagiroi_hide_candidates") then
        context:set_option("_kagiroi_expand_candidates", false)
        context:set_option("_kagiroi_hide_candidates", true)
    end
    Top.render(context)
end

function Top.select(context, direction, arrows)
    Top.sync(context)
    local state = Top.state(context)
    local clause = state.clauses[state.active]
    local first, count = 1, #clause.candidates
    if arrows and not context:get_option("_kagiroi_expand_candidates") then
        first = state.window_start + 1
        count = math.min(10, count - state.window_start)
    end
    clause.selected = first + (clause.selected - first + direction) % count
    clause.override = nil
    Top.render(context, clause)
end

function Top.page(context, direction)
    Top.sync(context)
    local state = Top.state(context)
    local clause = state.clauses[state.active]
    -- Pages follow the whole candidate count at the display width: ten per
    -- page while collapsed, thirty while expanded. The destination page's
    -- first candidate is selected and the pages wrap at both ends, so a
    -- single page still selects its own head
    -- (dotfiles/rime/SPEC.md, "候補選択の循環").
    local width = context:get_option("_kagiroi_expand_candidates") and 30 or 10
    local page = math.floor((clause.selected - 1) / width) + direction
    local last_page = math.floor(math.max(0, #clause.candidates - 1) / width)
    if page < 0 then page = last_page elseif page > last_page then page = 0 end
    clause.selected = page * width + 1
    clause.override = nil
    Top.render(context, clause)
end

local function selected_choice(clause)
    if clause.override then return nil end
    local chosen = clause.candidates[clause.selected]
    if not chosen or not chosen.entry then return nil end
    for _, choice in ipairs(clause.unfiltered) do
        if choice.entry and choice.entry.text == chosen.entry.text then
            return choice
        end
    end
    return chosen
end

local function history_entry(scope, reading, text, route)
    local entry = DictEntry()
    entry.text = text .. "|" .. kHistoryIds .. history_suffix(scope, route)
    entry.custom_code = reading .. " "
    return entry
end

local function invalidate_userdict_caches(viterbi)
    viterbi.lattice = {}
    viterbi.surface = ""
    viterbi.bos = nil
    local cache = viterbi.lookup_cache
    if cache then
        local keys = {}
        for key in cache:pairs() do keys[#keys + 1] = key end
        for _, key in ipairs(keys) do cache:delete(key) end
    end
end

function Top.learn(context)
    Top.sync(context)
    local env = session(context)
    local clauses = env.conversion.clauses
    env.mem:start_session()
    local join_text, join_reading, join_words = {}, {}, {}
    local joinable = #clauses >= 2
    for index, clause in ipairs(clauses) do
        local choice = selected_choice(clause)
        if choice then
            env.mem:update_userdict(history_entry("c", clause.reading, choice.text, choice.route_words), 1, "")
            join_text[index] = choice.text
            join_reading[index] = clause.reading
            join_words[index] = choice.route_words or false
        else
            joinable = false
        end
    end
    if joinable then
        local route, routed = {}, true
        for _, words in ipairs(join_words) do
            if not words then
                routed = false
            elseif routed then
                for _, node in ipairs(words) do route[#route + 1] = node end
            end
        end
        env.mem:update_userdict(history_entry("s", table.concat(join_reading),
            table.concat(join_text), routed and route or nil), 1, "")
    end
    local boundaries = {}
    for _, clause in ipairs(clauses) do boundaries[#boundaries + 1] = tostring(utf8.len(clause.reading)) end
    local reading = env.conversion.reading
    local entry = DictEntry()
    entry.custom_code = reading .. " "
    entry.text = reading .. "|" .. kHistoryIds .. kBoundaryMarker .. table.concat(boundaries, ",")
    env.mem:update_userdict(entry, 1, "")
    env.mem:finish_session()
    invalidate_userdict_caches(env.viterbi)
end

function Top.segment(segmentation, env)
    local state = Top.state(env.engine.context)
    if not state then return true end
    local start = segmentation:get_current_start_position()
    if start >= state.active_end then return false end
    local finish = start < state.active_start and state.active_start or state.active_end
    local segment = Segment(start, finish)
    segment.tags = Set({ start < state.active_start and "bunsetsu_fixed" or "bunsetsu_active" })
    segmentation:add_segment(segment)
    return false
end

function Top.func(input, seg, env)
    local state = env.conversion
    if not state then
        if utf8.len(input) then
            if env.engine.context:get_option("_kagiroi_hide_candidates") then
                env.mem:finish_session()
                return
            end
            return stock.func(input, seg, env)
        end
        return
    end
    if not seg:has_tag("bunsetsu_active") then return end
    for _, choice in ipairs(state.clauses[state.active].unfiltered) do
        yield(choice_candidate(choice, seg, env))
    end
end

-- Uniquifier checks the Menu's emitted candidates, so eagerly collecting
-- the complete stream also needs text deduplication before windowing it.
-- Stored choices retain their genuine dictionary entries, including emoji.
Top.filter = {
    tags_match = function(seg, env)
        env.segment = seg
        return seg:has_tag("bunsetsu_active")
    end,
    func = function(translation, env)
        local context = env.engine.context
        local state = Top.state(context)
        local clause = state.clauses[state.active]
        if state.collecting then save_filtered(clause, translation) end
        local first = state.collecting and 1 or state.window_start + 1
        local last = context:get_option("_kagiroi_expand_candidates") and #clause.candidates
            or math.min(#clause.candidates, first + 9)
        for index = first, last do
            yield(choice_candidate(clause.candidates[index], env.segment, session(context)))
        end
    end,
}

return Top
