-- Keeps the candidate list hidden while the _kagiroi_hide_candidates option
-- is on. The name deliberately carries no core meaning on any librime
-- version, so hiding is performed by this filter alone and behaves the same
-- on Windows (librime 1.13.1) and Linux (librime 1.16).
local function hide_or_pass(translation, env)
    local context = env.engine.context
    if context:get_option("_kagiroi_hide_candidates") then
        return
    end
    local expanded = context:get_option("_kagiroi_expand_candidates")
    local width = expanded and 30 or 10
    -- The bunsetsu window may have skipped earlier candidates of the final
    -- display order (a collapsed page after Space crossed the first window
    -- or PageUp/PageDown). Page comments count the whole final order, so
    -- the skipped candidates still count towards the page number
    -- (dotfiles/rime/SPEC.md, "候補一覧の見た目").
    local offset = tonumber(context:get_property("_kagiroi_page_offset")) or 0
    local count = 0
    for candidate in translation:iter() do
        local index = offset + count
        if index % width == 0 then
            local page_comment = "Page " .. (math.floor(index / width) + 1)
            local comment = candidate.comment or ""
            if comment ~= "" then
                page_comment = comment .. " " .. page_comment
            end
            candidate = candidate:to_shadow_candidate(candidate.type, candidate.text, page_comment)
        end
        yield(candidate)
        count = count + 1
        if not expanded and count == 10 then
            return
        end
    end
end

return { func = hide_or_pass }
