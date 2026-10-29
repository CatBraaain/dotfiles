-- Per-context clause choices, the active-clause menu and the full preview.
local Top = {}
local sessions = {}
local next_session = 0
local stock
local variants = require("kagiroi/char_variants")
local segmenter_loaded, segmenter = pcall(require, "kagiroi/segmenter")

local kContextualDiscoveryLimit = 30

local function path_precedes(a, b)
    if a.score ~= b.score then return a.score < b.score end
    if a.node._end ~= b.node._end then return a.node._end > b.node._end end
    return a.sequence < b.sequence
end

local function heap_push(heap, item)
    heap[#heap + 1] = item
    local index = #heap
    while index > 1 do
        local parent = math.floor(index / 2)
        if not path_precedes(heap[index], heap[parent]) then break end
        heap[parent], heap[index] = heap[index], heap[parent]
        index = parent
    end
end

local function heap_pop(heap)
    local top = heap[1]
    local last = table.remove(heap)
    if #heap > 0 then
        heap[1] = last
        local index = 1
        while true do
            local left, right, smallest = index * 2, index * 2 + 1, index
            if left <= #heap and path_precedes(heap[left], heap[smallest]) then smallest = left end
            if right <= #heap and path_precedes(heap[right], heap[smallest]) then smallest = right end
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
    next_session = next_session + 1
    env.session_id = tostring(next_session)
    env.engine.context:set_property("_kagiroi_bunsetsu_session", env.session_id)
    sessions[env.session_id] = env
    local context = env.engine.context
    env.option_connection = context.option_update_notifier:connect(function(_, option)
        if option == "emoji" and env.conversion then
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
    local candidates, seen = {}, {}
    for candidate in translation:iter() do
        if not seen[candidate.text] then
            seen[candidate.text] = true
            local genuine = candidate:get_genuine()
            local phrase = genuine:to_phrase()
            candidates[#candidates + 1] = {
                text = candidate.text,
                comment = candidate.comment,
                source_text = genuine.text,
                entry = phrase and DictEntry(phrase.entry),
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
    return type(env.viterbi) == "table" and env.viterbi.lattice ~= nil
        and type(env.viterbi._get_matrix_cost) == "function"
        and env.viterbi.eos ~= nil
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

local function contextual_score(choice, env, context)
    if not choice.own then return nil end
    local left_term = left_boundary_term(env, context, choice.left_id)
    if not left_term then return nil end
    local right_term = right_boundary_term(env, context, choice.right_id)
    if not right_term then return nil end
    return choice.own + left_term + right_term
end

local function starting_nodes(viterbi, length)
    local starting = {}
    for position = 1, length do
        for _, node in ipairs(viterbi.lattice[position] or {}) do
            local key = node.start
            starting[key] = starting[key] or {}
            starting[key][#starting[key] + 1] = node
        end
    end
    return starting
end

local function dictionary_nodes(viterbi, reading)
    local length = utf8.len(reading)
    if type(viterbi._lookup) ~= "function" then return starting_nodes(viterbi, length) end
    local offsets = {}
    for offset in utf8.codes(reading) do offsets[#offsets + 1] = offset end
    offsets[#offsets + 1] = #reading + 1
    local starting = {}
    for first = 1, length do
        local nodes = {}
        for last = first, length do
            local surface = reading:sub(offsets[first], offsets[last + 1] - 1)
            for lex in viterbi:_lookup(surface) do
                nodes[#nodes + 1] = {
                    start = first, _end = last,
                    candidate = lex.candidate, left_id = lex.left_id, right_id = lex.right_id,
                    wcost = lex.cost,
                }
            end
        end
        starting[first] = nodes
    end
    return starting
end

local function completion_costs(starting, length, env, context)
    local remaining = {}
    for position = length, 1, -1 do
        for _, node in ipairs(starting[position] or {}) do
            if node._end == length then
                remaining[node] = right_boundary_term(env, context, node.right_id)
            else
                local best
                for _, successor in ipairs(starting[node._end + 1] or {}) do
                    local conn = matrix_cost(env, node.right_id, successor.left_id)
                    local tail = remaining[successor]
                    if conn and tail then
                        local cost = conn + successor.wcost + tail
                        if not best or cost < best then best = cost end
                    end
                end
                remaining[node] = best
            end
        end
    end
    return remaining
end

local function contextual_path_enum(reading, env, context, stock_texts, starting)
    local length = utf8.len(reading)
    local remaining = completion_costs(starting, length, env, context)
    local heap, cheapest_prefix = {}, {}
    local sequence = 0
    local function offer(node, text, first_left, own, left_term)
        local tail = remaining[node]
        if not tail then return end
        local prefixes = cheapest_prefix[node] or {}
        cheapest_prefix[node] = prefixes
        local key = text .. "|" .. first_left
        local previous = prefixes[key]
        if previous and previous <= own then return end
        prefixes[key] = own
        sequence = sequence + 1
        heap_push(heap, {
            sequence = sequence,
            node = node, text = text, first_left_id = first_left,
            own = own, left_term = left_term, key = key,
            score = left_term + own + tail,
        })
    end
    for _, node in ipairs(starting[1] or {}) do
        local term = left_boundary_term(env, context, node.left_id)
        if term then offer(node, node.candidate, node.left_id, node.wcost, term) end
    end
    local results, seen = {}, {}
    while heap[1] and #results < kContextualDiscoveryLimit do
        local path = heap_pop(heap)
        local node = path.node
        if cheapest_prefix[node][path.key] == path.own then
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
                            path.own + conn + successor.wcost, path.left_term)
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

local function text_route_pairs(starting, length, text, matrix_cost)
    local states = { [0] = { { offset = 0 } } }
    local pairs_by_key, states_by_node = {}, {}
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
                                own, first_left = incoming.own + conn + node.wcost, incoming.first_left
                            end
                        else
                            own, first_left = node.wcost, node.left_id
                        end
                        if own then
                            local next_offset = from + #node.candidate - 1
                            if node._end == length then
                                if next_offset == #text then
                                    local key = first_left .. " " .. node.right_id
                                    local current = pairs_by_key[key]
                                    if not current or own < current.own then
                                        pairs_by_key[key] =
                                            { left_id = first_left, right_id = node.right_id, own = own }
                                    end
                                end
                            else
                                local bucket = states[node._end] or {}
                                local node_states = states_by_node[node] or {}
                                states_by_node[node] = node_states
                                local key = first_left .. " " .. next_offset
                                local existing = node_states[key]
                                if existing then
                                    if own < existing.own then existing.own = own end
                                else
                                    local state = {
                                        node = node,
                                        first_left = first_left,
                                        offset = next_offset,
                                        own = own,
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
        return a.right_id < b.right_id
    end)
    return routes
end

local function attach_pair_routes(candidates, reading, env, starting, route_cache)
    local length = utf8.len(reading)
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
        rows[#rows + 1] = choice
    end
    for _, text in ipairs(texts) do
        local rows = rows_by_text[text]
        local route_pairs = route_cache[text]
        if not route_pairs then
            route_pairs = text_route_pairs(starting, length, text,
                function(right_id, left_id) return matrix_cost(env, right_id, left_id) end)
            route_cache[text] = route_pairs
        end
        for _, route in ipairs(route_pairs) do
            local matched = false
            for _, choice in ipairs(rows) do
                if choice.left_id == route.left_id and choice.right_id == route.right_id then
                    choice.own = route.own
                    matched = true
                    break
                end
            end
            if not matched then
                local entry = DictEntry()
                entry.text = text .. "|" .. route.left_id .. " " .. route.right_id
                entry.custom_code = reading .. " "
                rows[#rows + 1] = {
                    text = text,
                    comment = "",
                    source_text = entry.text,
                    entry = entry,
                    left_id = route.left_id,
                    right_id = route.right_id,
                    own = route.own,
                }
                candidates[#candidates + 1] = rows[#rows]
            end
        end
    end
end

local function attach_contextual_costs(candidates, reading, env, context)
    local stock_texts = {}
    for _, choice in ipairs(candidates) do stock_texts[choice.text] = true end
    candidates.stock_texts = stock_texts
    local starting = dictionary_nodes(env.viterbi, reading)
    local route_cache = {}
    attach_pair_routes(candidates, reading, env, starting, route_cache)
    context = context or { at_start = true, at_end = true }
    local enumerated = contextual_path_enum(reading, env, context, stock_texts, starting)
    if enumerated then
        apply_enumerated_paths(candidates, reading, enumerated)
        attach_pair_routes(candidates, reading, env, starting, route_cache)
    end
    return starting, route_cache
end

local function context_key(context)
    if not context then return "unavailable" end
    return table.concat({ tostring(context.at_start), tostring(context.at_end),
        context.prev_right_id or 0, context.next_left_id or 0 }, ":")
end

local function reorder_contextual(clause, env, context)
    local key = context_key(context)
    clause.discovered_contexts = clause.discovered_contexts or {}
    if not clause.discovered_contexts[key] then
        local enumerated = contextual_path_enum(clause.reading, env, context, clause.stock_texts, clause.starting)
        apply_enumerated_paths(clause.unfiltered, clause.reading, enumerated)
        attach_pair_routes(clause.unfiltered, clause.reading, env, clause.starting, clause.route_cache)
    end
    clause.discovered_contexts[key] = true
    local scored, unscored = {}, {}
    for _, choice in ipairs(clause.unfiltered) do
        if not choice.order then
            clause.next_order = (clause.next_order or 0) + 1
            choice.order = clause.next_order
        end
        local score = contextual_score(choice, env, context)
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
    if path_spec then
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
        clause.own_attached = true
        clause.stock_texts = clause.unfiltered.stock_texts
        clause.discovered_contexts = { [context_key(context or { at_start = true, at_end = true })] = true }
        if path_spec then
            for index, choice in ipairs(clause.unfiltered) do
                if choice.text == path_spec.text and choice.left_id == path_spec.left_id
                    and choice.right_id == path_spec.right_id then
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

local function split_via_path(reading, env)
    if not segmenter_loaded then return nil end
    local path = best_path_nodes(env.viterbi)
    if not path or #path == 0 then return nil end
    local specs = {}
    local covered = 0
    local current = {}
    for i, node in ipairs(path) do
        current[#current + 1] = node
        covered = covered + #node.surface
        local next_node = path[i + 1]
        if not next_node or segmenter.is_boundary_internal(node.right_id, next_node.left_id) then
            specs[#specs + 1] = current
            current = {}
        end
    end
    if #current > 0 or covered ~= #reading then return nil end
    local mapped = {}
    for _, group in ipairs(specs) do
        local surfaces, texts = {}, {}
        for i, node in ipairs(group) do
            surfaces[#surfaces + 1] = node.surface
            texts[#texts + 1] = node.candidate
            if i == 1 then mapped[#mapped + 1] = { left_id = node.left_id } end
            local spec = mapped[#mapped]
            spec.reading = (spec.reading or "") .. node.surface
            spec.text = table.concat(texts)
            spec.right_id = node.right_id
        end
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

local function collect_filtered(context, state, index)
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
end

local function settle_contextual(context, state, env)
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
        if not clause.filtered or clause.ranked_context ~= key then
            if score_context then reorder_contextual(clause, env, score_context) end
            collect_filtered(context, state, index)
            clause.ranked_context = key
        end
        if select_first then clause.selected = 1 end
        local after_left, after_right = selected_ids(clause)
        if before_left ~= after_left then enqueue(index - 1) end
        if before_right ~= after_right then enqueue(index + 1) end
    end
    state.first_choices = nil
end

local function split(reading, env)
    local clauses = {}
    local contextual = false
    local position = 1
    while position <= #reading do
        local kana = is_kana(utf8.codepoint(reading, position))
        local run_end = position
        for offset, codepoint in utf8.codes(reading:sub(position)) do
            if is_kana(codepoint) ~= kana then break end
            run_end = position + offset - 1 + #utf8.char(codepoint)
        end
        local remaining = reading:sub(position, run_end - 1)
        if kana then
            env.viterbi:analyze(remaining)
            if viterbi_supports_context(env) then
                local mapped = split_via_path(remaining, env)
                if mapped then
                    contextual = true
                    for index, spec in ipairs(mapped) do
                        local context = {
                            at_start = #clauses == 0 and index == 1,
                            at_end = index == #mapped,
                            prev_right_id = 0,
                            next_left_id = mapped[index + 1] and mapped[index + 1].left_id or 0,
                        }
                        if index > 1 then context.prev_right_id = mapped[index - 1].right_id end
                        clauses[#clauses + 1] = new_clause(spec.reading, env, context, spec)
                    end
                    position = run_end
                    goto continue_run
                end
            end
        end
        while remaining ~= "" do
            local prefix = remaining
            if kana then
                env.viterbi:analyze(remaining)
                local lex = env.viterbi:best_n_prefix()()
                if lex and lex.surface ~= "" then prefix = lex.surface end
            end
            clauses[#clauses + 1] = new_clause(prefix, env)
            remaining = remaining:sub(#prefix + 1)
        end
        ::continue_run::
        position = run_end
    end
    return clauses, contextual
end

function Top.start(context, reading, katakana)
    local env = session(context)
    local clauses, contextual
    if katakana then
        clauses = { new_clause(reading, env) }
    else
        clauses, contextual = split(reading, env)
    end
    if katakana then clauses[1].override = katakana end
    env.conversion = { reading = reading, clauses = clauses, active = 1,
        henkan = katakana ~= nil, contextual = contextual }
    if contextual then
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
            Top.render(context)
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

function Top.render(context)
    local state = Top.state(context)
    local active_index = state.active
    settle_contextual(context, state, session(context))
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
    state.clauses[index] = new_clause(left_reading, env)
    local right_reshaped = right_reading ~= ""
    if right_reading == "" then table.remove(state.clauses, index + 1)
    elseif right then state.clauses[index + 1] = new_clause(right_reading, env)
    else table.insert(state.clauses, index + 1, new_clause(right_reading, env)) end
    state.henkan = false
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
    Top.render(context)
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
    Top.render(context)
end

-- The joined entry records the whole reading so the next conversion can
-- find it directly: stock kagiroi writes one through its memorize
-- callback, which the commit here (engine:commit_text) never reaches
-- (dotfiles/rime/SPEC.md, "確定と次入力"). A clause without a dictionary
-- entry keeps the reading out of the join, since the join would not match
-- what the display shows for that clause.
local function joined_sentence_entry(clauses)
    local text, reading = {}, {}
    local first_left_id, last_right_id
    for index, clause in ipairs(clauses) do
        local entry = not clause.override and clause.candidates[clause.selected].entry
        local candidate, left_id, right_id
        if entry then
            candidate, left_id, right_id = string.match(entry.text, "(.+)|(-?%d+) (-?%d+)")
            reading[index] = string.match(entry.custom_code or "", "^(.-) $")
        end
        if not candidate or reading[index] == "" then return nil end
        text[index] = candidate
        first_left_id = first_left_id or left_id
        last_right_id = right_id
    end
    if #text < 2 then return nil end
    local sentence = DictEntry()
    sentence.text = table.concat(text) .. "|" .. first_left_id .. " " .. last_right_id
    sentence.custom_code = table.concat(reading) .. " "
    return sentence
end

-- Frequency learning lowers a word's own cost only, so storing the original
-- connection ids can leave a disfavoured candidate unpromotable; learned
-- entries use the generic noun ids (dotfiles/rime/SPEC.md, "確定と次入力").
local function learnable_entry(entry)
    if not entry then return nil end
    local stored = DictEntry(entry)
    stored.text = string.gsub(entry.text, "|%-?%d+ %-?%d+$", "|1851 1851")
    return stored
end

function Top.learn(context)
    Top.sync(context)
    local env = session(context)
    for _, clause in ipairs(env.conversion.clauses) do
        local entry = not clause.override and clause.candidates[clause.selected].entry
        local stored = learnable_entry(entry)
        if stored then env.mem:update_userdict(stored, 1, "") end
    end
    local sentence = learnable_entry(joined_sentence_entry(env.conversion.clauses))
    if sentence then env.mem:update_userdict(sentence, 1, "") end
    env.viterbi:clear()
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
