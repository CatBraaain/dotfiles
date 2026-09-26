local function is_fullwidth_katakana(candidate)
    for _, genuine in ipairs(candidate:get_genuines()) do
        if genuine.type == "kagiroi" and genuine:get_dynamic_type() == "Simple" then
            return true
        end
    end
    return false
end

local function promote_henkan_candidate(input, env)
    if not env.engine.context:get_option("_weasel_henkan") then
        for candidate in input:iter() do
            yield(candidate)
        end
        return
    end

    local preceding = {}
    local promoted = false
    for candidate in input:iter() do
        if not promoted and is_fullwidth_katakana(candidate) then
            yield(candidate)
            for _, earlier in ipairs(preceding) do
                yield(earlier)
            end
            promoted = true
        elseif promoted then
            yield(candidate)
        else
            preceding[#preceding + 1] = candidate
        end
    end
    if not promoted then
        for _, candidate in ipairs(preceding) do
            yield(candidate)
        end
    end
end

return { func = promote_henkan_candidate }
