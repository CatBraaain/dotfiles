/*
 * Headless behavior harness for the managed Kagiroi Rime config.
 *
 * The workspace argument must contain the deployed layout: the managed files
 * from dotfiles/rime (default.custom.yaml, kagiroi.custom.yaml, the custom
 * dictionaries and lua/) plus the stock Kagiroi schema, dictionaries and lua/
 * from the local mirror. run.sh assembles it and compiles this file.
 *
 * Scenario order follows dotfiles/rime/SPEC.md: input and conversion
 * (schema, n-run correction, first candidate), then common key handling
 * (Zenkaku_Hankaku, Henkan, candidate gate).
 *
 * Usage: harness <user_data_dir> [-v]
 * Exit status is 0 when every check passes.
 */
#include <rime_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define kSpace 0x20
#define kReturn 0xff0d
#define kHenkan 0xff23
#define kZenkakuHankaku 0xff2a
#define kBackSpace 0xff08
#define kEscape 0xff1b
#define kTab 0xff09

static RimeApi* rime = NULL;
static RimeSessionId session = 0;
static int g_checks = 0;
static int g_failures = 0;
static int g_verbose = 0;

static void check(Bool condition, const char* description) {
    ++g_checks;
    if (!condition) {
        ++g_failures;
        fprintf(stderr, "FAIL: %s\n", description);
    }
}

static void press(int keycode) {
    rime->process_key(session, keycode, 0);
}

static void type_text(const char* ascii) {
    for (const unsigned char* p = (const unsigned char*)ascii; *p; ++p) {
        press(*p);
    }
}

static Bool option(const char* name) {
    return rime->get_option(session, name);
}

static Bool composing(void) {
    RIME_STRUCT(RimeStatus, status);
    Bool result = rime->get_status(session, &status) && status.is_composing;
    rime->free_status(&status);
    return result;
}

/* The commit, if one has been produced since the last poll. */
static Bool take_commit(char* buffer, size_t size) {
    RIME_STRUCT(RimeCommit, commit);
    Bool result = False;
    if (rime->get_commit(session, &commit) && commit.text) {
        snprintf(buffer, size, "%s", commit.text);
        result = True;
    }
    rime->free_commit(&commit);
    return result;
}

/* menu.candidates is only valid while context is alive. */
static Bool current_menu(RimeContext* context) {
    return rime->get_context(session, context);
}

static int menu_has_candidate(RimeContext* context, const char* text) {
    for (int i = 0; i < context->menu.num_candidates; ++i) {
        const char* candidate = context->menu.candidates[i].text;
        if (candidate && strstr(candidate, text)) return 1;
    }
    return 0;
}

static void print_context(void) {
    RIME_STRUCT(RimeContext, context);
    if (!rime->get_context(session, &context)) return;
    printf("  preedit: %s\n", context.composition.preedit ? context.composition.preedit : "(none)");
    printf("  candidates: %d highlighted: %d\n", context.menu.num_candidates,
           context.menu.highlighted_candidate_index);
    for (int i = 0; i < context.menu.num_candidates; ++i) {
        printf("  %d. %s\n", i, context.menu.candidates[i].text ? context.menu.candidates[i].text : "");
    }
    rime->free_context(&context);
}

static void fresh_session(void) {
    if (session) rime->destroy_session(session);
    session = rime->create_session();
    rime->select_schema(session, "kagiroi");
    char schema[64] = {0};
    rime->get_current_schema(session, schema, sizeof(schema));
    if (strcmp(schema, "kagiroi") != 0) {
        fprintf(stderr, "FAIL: expected the kagiroi schema, got '%s'\n", schema);
        ++g_failures;
    }
}

/* SPEC: the default schema is kagiroi before any explicit selection. */
static void test_default_schema_is_kagiroi(void) {
    if (session) rime->destroy_session(session);
    session = rime->create_session();
    char schema[64] = {0};
    rime->get_current_schema(session, schema, sizeof(schema));
    check(strcmp(schema, "kagiroi") == 0,
          "the default schema must be kagiroi without explicit selection");
}

/* SPEC: accepted n-run forms expose a candidate containing the reading's
 * dictionary word. Readings without a matching dictionary word (こにちは,
 * かんだ, にゃ) are checked as preedit in test_n_run_preedit and
 * test_n_run_conversion_reading. */
static void test_n_run_correction(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"kanji", "漢字"},
        {"kannji", "漢字"},
        {"kannnji", "漢字"},
        {"kana", "かな"},
        {"kanna", "かんな"},
        {"kannna", "かんな"},
        {"kannnna", "かんな"},
        {"konnnitiha", "こんにちは"},
        {"kannnen", "観念"},
        {"kannnnen", "観念"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        press(kSpace);
        RIME_STRUCT(RimeContext, context);
        Bool found = False;
        if (rime->get_context(session, &context)) {
            found = menu_has_candidate(&context, cases[i].expected);
            if (g_verbose) {
                printf("  %s:\n", cases[i].input);
                print_context();
            }
            rime->free_context(&context);
        }
        check(found, cases[i].input);
        if (!found) {
            fprintf(stderr, "      expected a candidate containing %s\n", cases[i].expected);
        }
    }
}

/* SPEC: accepted n-run forms read exactly as the SPEC table says while
 * composing; excessive n runs are not corrected while typing. */
static void test_n_run_preedit(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"kan", "かn"},
        {"kanji", "かんじ"},
        {"kannji", "かんじ"},
        {"kannnji", "かんんじ"},
        {"kana", "かな"},
        {"kanna", "かんな"},
        {"kannna", "かんな"},
        {"kannnna", "かんんあ"},
        {"konitiha", "こにちは"},
        {"konnnitiha", "こんにちは"},
        {"kanda", "かんだ"},
        {"kannda", "かんだ"},
        {"kannnda", "かんんだ"},
        {"nya", "にゃ"},
        {"kannnen", "かんねn"},
        {"kannnnen", "かんんえn"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        RIME_STRUCT(RimeContext, context);
        if (!rime->get_context(session, &context)) {
            check(False, "typing must keep a queryable context");
            continue;
        }
        char description[128];
        snprintf(description, sizeof(description), "%s must read %s while composing",
                 cases[i].input, cases[i].expected);
        check(context.composition.preedit &&
                  strcmp(context.composition.preedit, cases[i].expected) == 0,
              description);
        rime->free_context(&context);
    }
}

/* SPEC: n followed by Space resolves to ん and starts the conversion. */
static void test_kan_space_starts_conversion(void) {
    fresh_session();
    type_text("kan");
    press(kSpace);
    check(composing(), "Space must start the conversion of the pending n");
    RIME_STRUCT(RimeContext, context);
    if (!rime->get_context(session, &context)) {
        check(False, "Space must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates > 0,
          "Space must expose candidates for the reading かん");
    check(context.composition.preedit && strcmp(context.composition.preedit, "かん") == 0,
          "the reading after n + Space must be かん");
    rime->free_context(&context);
}

/* SPEC: Space converts with the corrected reading: consecutive ん fold into
 * one and a leftover ん binds with a following vowel. */
static void test_n_run_conversion_reading(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"kan", "かん"},
        {"kanji", "かんじ"},
        {"kannji", "かんじ"},
        {"kannnji", "かんじ"},
        {"kanda", "かんだ"},
        {"kannda", "かんだ"},
        {"kannnda", "かんだ"},
        {"kana", "かな"},
        {"nya", "にゃ"},
        {"kanna", "かんな"},
        {"kannna", "かんな"},
        {"kannnna", "かんな"},
        {"konnnitiha", "こんにちは"},
        {"kannnen", "かんねん"},
        {"kannnnen", "かんねん"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        press(kSpace);
        RIME_STRUCT(RimeContext, context);
        if (!rime->get_context(session, &context)) {
            check(False, "conversion must keep a queryable context");
            continue;
        }
        char description[128];
        snprintf(description, sizeof(description), "%s must convert with the reading %s",
                 cases[i].input, cases[i].expected);
        check(context.composition.preedit &&
                  strcmp(context.composition.preedit, cases[i].expected) == 0,
              description);
        rime->free_context(&context);
    }
}

/* SPEC: Zenkaku_Hankaku toggles between Japanese and ASCII input. */
static void test_zenkaku_hankaku_toggles_ascii(void) {
    fresh_session();
    press(kZenkakuHankaku);
    check(option("ascii_mode"), "Zenkaku_Hankaku must enable ascii mode");
    press(kZenkakuHankaku);
    check(!option("ascii_mode"), "Zenkaku_Hankaku must restore Japanese mode");
    /* The toggle must also work outside a composition. */
    RIME_STRUCT(RimeStatus, status);
    Bool composing_before = rime->get_status(session, &status) && status.is_composing;
    rime->free_status(&status);
    check(!composing_before, "the session must stay idle outside a composition");
}

/* SPEC: Henkan keeps the composition unconfirmed, shows the first candidate
 * as katakana in the preedit, and keeps the candidate list hidden. */
static void test_henkan_promotes_katakana(void) {
    fresh_session();
    type_text("kanji");
    press(kHenkan);
    check(composing(), "Henkan must keep the composition open");
    RIME_STRUCT(RimeContext, context);
    Bool promoted = False;
    if (rime->get_context(session, &context)) {
        promoted = context.menu.num_candidates == 0 &&
                   context.composition.preedit &&
                   strcmp(context.composition.preedit, "カンジ") == 0;
        if (g_verbose) print_context();
        rime->free_context(&context);
    }
    check(promoted, "Henkan must show the katakana first candidate with the list hidden");
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "Henkan must not commit");
}

/* SPEC: after Henkan, Space reveals the menu with the katakana first
 * candidate selected, Enter commits it, and the next typing hides candidates
 * again. */
static void test_henkan_space_enter_chain(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kHenkan);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "the context must exist after Henkan");
        return;
    }
    check(context.menu.num_candidates == 0, "Henkan must keep the menu hidden after Space");
    rime->free_context(&context);
    press(kSpace);
    if (!rime->get_context(session, &context)) {
        check(False, "the menu must survive Space after Henkan");
        return;
    }
    check(composing(), "Space after Henkan must keep the composition open");
    check(context.menu.num_candidates > 0,
          "Space after Henkan must reveal the candidate menu");
    check(context.menu.highlighted_candidate_index == 0,
          "Space after Henkan must select the first candidate");
    check(context.menu.candidates[0].text &&
              strcmp(context.menu.candidates[0].text, "カンジ") == 0,
          "the first candidate after Henkan must be the katakana reading");
    rime->free_context(&context);
    press(kReturn);
    check(composing() == False, "Enter after Henkan must end the composition");
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "カンジ") == 0,
          "Enter must commit the katakana selected after Henkan");
    type_text("kanji");
    RIME_STRUCT(RimeContext, next);
    if (rime->get_context(session, &next)) {
        check(composing(), "next typing must start a new composition");
        check(next.menu.num_candidates == 0,
              "next typing must hide candidates until Space again");
        rime->free_context(&next);
    } else {
        check(False, "next typing must keep a queryable context");
    }
}

/* SPEC: Backspace and Esc keep the string unconfirmed, return it to the
 * hiragana reading and hide the list; Backspace while typing deletes the
 * previous character and Esc while typing clears the whole composition. */
static void test_backspace_escape_return_to_reading(void) {
    /* Backspace with the menu visible. */
    fresh_session();
    type_text("kana");
    press(kSpace);
    press(kBackSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "Backspace must keep a queryable context");
        return;
    }
    check(composing(), "Backspace must keep the composition open");
    check(context.menu.num_candidates == 0, "Backspace must hide the candidate list");
    check(context.composition.preedit && strcmp(context.composition.preedit, "かな") == 0,
          "Backspace must return to the full hiragana reading");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "Backspace must not commit");
    /* Backspace while typing deletes the previous character. */
    press(kBackSpace);
    if (!current_menu(&context)) {
        check(False, "the second Backspace must keep a queryable context");
        return;
    }
    check(composing(), "Backspace while typing must keep composing");
    check(context.composition.preedit && strcmp(context.composition.preedit, "か") == 0,
          "Backspace while typing must delete the previous character");
    rime->free_context(&context);

    /* Esc while typing clears the whole composition. */
    fresh_session();
    type_text("kana");
    press(kEscape);
    check(!composing(), "Esc while typing must clear the composition");
    check(!take_commit(commit, sizeof(commit)), "Esc while typing must not commit");

    /* Esc with the menu visible. */
    fresh_session();
    type_text("kana");
    press(kSpace);
    press(kEscape);
    if (!current_menu(&context)) {
        check(False, "Esc with the menu visible must keep a queryable context");
        return;
    }
    check(composing(), "Esc with the menu visible must keep composing");
    check(context.menu.num_candidates == 0, "Esc with the menu visible must hide the list");
    check(context.composition.preedit && strcmp(context.composition.preedit, "かな") == 0,
          "Esc with the menu visible must return to the reading");
    rime->free_context(&context);
    check(!take_commit(commit, sizeof(commit)), "Esc with the menu visible must not commit");
}

/* SPEC: a regular typing key with the menu visible commits the selected
 * candidate and starts the next input; digits never pick candidates. */
static void test_typing_key_commits_selection(void) {
    /* A letter key commits the selection and starts a new input. */
    fresh_session();
    type_text("kana");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    char expected[256] = "";
    if (current_menu(&context)) {
        int highlighted = context.menu.highlighted_candidate_index;
        if (highlighted < context.menu.num_candidates &&
            context.menu.candidates[highlighted].text) {
            snprintf(expected, sizeof(expected), "%s",
                     context.menu.candidates[highlighted].text);
        }
        rime->free_context(&context);
    } else {
        check(False, "the menu must exist before the typing key");
    }
    check(expected[0] != '\0', "the highlighted candidate must have text");
    press('k');
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "a typing key must commit the selected candidate");
    if (!current_menu(&context)) {
        check(False, "the restarted input must keep a queryable context");
        return;
    }
    check(composing(), "the restarted key must start a new composition");
    check(context.menu.num_candidates == 0,
          "the restarted input must hide candidates until Space");
    rime->free_context(&context);

    /* A digit key commits the highlighted candidate, not candidate number one. */
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the menu must exist before the digit key");
        return;
    }
    check(context.menu.highlighted_candidate_index == 1,
          "cycling must select the second candidate before the digit key");
    snprintf(expected, sizeof(expected), "%s",
             context.menu.candidates[context.menu.highlighted_candidate_index].text
                 ? context.menu.candidates[context.menu.highlighted_candidate_index].text
                 : "");
    rime->free_context(&context);
    check(expected[0] != '\0', "the cycled candidate must have text");
    press('1');
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "a digit must commit the highlighted candidate instead of selecting by number");
    if (!current_menu(&context)) {
        check(False, "the digit must leave a queryable next input");
        return;
    }
    check(composing(), "the digit must start the next composition");
    check(context.composition.preedit && strcmp(context.composition.preedit, "1") == 0,
          "the digit must be the next input reading");
    check(context.menu.num_candidates == 0, "the digit must keep the next menu hidden");
    if (g_verbose) print_context();
    rime->free_context(&context);
}

/*
 * SPEC: comma and period with the menu visible commit the selected candidate
 * and append the full-width punctuation (dotfiles/rime/SPEC.md).
 */
static void test_comma_period_commit_selection(void) {
    static const struct {
        int key;
        const char* name;
        const char* punct;
    } cases[] = {
        {',', "comma", "、"},
        {'.', "period", "。"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text("kanji");
        press(kSpace);
        press(kSpace);
        RIME_STRUCT(RimeContext, context);
        char expected[256] = "";
        if (current_menu(&context)) {
            int highlighted = context.menu.highlighted_candidate_index;
            if (highlighted < context.menu.num_candidates &&
                context.menu.candidates[highlighted].text) {
                snprintf(expected, sizeof(expected), "%s%s",
                         context.menu.candidates[highlighted].text, cases[i].punct);
            }
            rime->free_context(&context);
        } else {
            check(False, "the menu must exist before the punctuation key");
        }
        check(expected[0] != '\0', "the highlighted candidate must have text");
        press(cases[i].key);
        char commit[256];
        char description[128];
        snprintf(description, sizeof(description),
                 "%s with the menu visible must commit the selection and %s",
                 cases[i].name, cases[i].punct);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
              description);
        check(!composing(), "the punctuation key must end the composition");
    }
}

/* SPEC: Tab moves the selection to the next candidate without committing. */
static void test_tab_moves_to_next_candidate(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "the menu must exist before Tab");
        return;
    }
    check(context.menu.highlighted_candidate_index == 0,
          "the first candidate must be selected before Tab");
    rime->free_context(&context);
    press(kTab);
    if (!current_menu(&context)) {
        check(False, "the menu must survive Tab");
        return;
    }
    check(composing(), "Tab must keep the composition open");
    check(context.menu.highlighted_candidate_index == 1,
          "Tab must move the selection to the next candidate");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "Tab must not commit");
}

/*
 * SPEC: one page holds up to 30 candidates, standing in for the MS-IME
 * expanded list (dotfiles/rime/SPEC.md).
 */
static void test_page_size_is_30(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "the menu must exist for the page size check");
        return;
    }
    check(context.menu.num_candidates > 5,
          "the menu must hold more than the stock page size of five");
    check(context.menu.num_candidates <= 30,
          "the menu must hold at most one page of 30 candidates");
    rime->free_context(&context);
}

/* SPEC: an ordinary key after Henkan commits katakana and starts the next
 * full-width reading without opening the candidate list. */
static void test_henkan_typing_key_starts_next_input(void) {
    static const struct {
        int key;
        const char* reading;
        const char* description;
    } cases[] = {
        {'k', "k", "letter"},
        {'1', "1", "digit"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text("kanji");
        press(kHenkan);
        press(cases[i].key);
        char commit[256];
        char description[128];
        snprintf(description, sizeof(description), "Henkan then %s must commit katakana",
                 cases[i].description);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, "カンジ") == 0,
              description);
        RIME_STRUCT(RimeContext, context);
        if (!current_menu(&context)) {
            check(False, "Henkan then typing must leave a queryable next input");
            continue;
        }
        snprintf(description, sizeof(description), "Henkan then %s must start composing",
                 cases[i].description);
        check(composing(), description);
        snprintf(description, sizeof(description), "Henkan then %s must start the next reading",
                 cases[i].description);
        check(context.composition.preedit &&
                  strcmp(context.composition.preedit, cases[i].reading) == 0,
              description);
        check(context.menu.num_candidates == 0,
              "Henkan then typing must keep the next menu hidden");
        if (g_verbose) print_context();
        rime->free_context(&context);
    }
}

/* The preedit a typed sequence leaves while composing. */
static Bool preedit_equals(const char* expected) {
    RIME_STRUCT(RimeContext, context);
    Bool result = False;
    if (rime->get_context(session, &context)) {
        result = context.composition.preedit &&
                 strcmp(context.composition.preedit, expected) == 0;
        if (g_verbose) print_context();
        rime->free_context(&context);
    }
    return result;
}

/*
 * SPEC: in the Japanese mode comma and period commit ，and 。directly, and
 * the half/full width table keeps committing them (dotfiles/rime/SPEC.md).
 */
static void test_punctuation_commits_directly(void) {
    static const struct {
        int key;
        const char* name;
        const char* expected;
    } cases[] = {
        {',', "comma", "、"},
        {'.', "period", "。"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        press(cases[i].key);
        char commit[256];
        char description[128];
        snprintf(description, sizeof(description),
                 "%s must commit %s directly while typing is idle",
                 cases[i].name, cases[i].expected);
        Bool committed = take_commit(commit, sizeof(commit));
        check(committed && strcmp(commit, cases[i].expected) == 0, description);
        snprintf(description, sizeof(description),
                 "%s must not keep composing after the commit", cases[i].name);
        check(!composing(), description);
    }
    /* The half/full width table already commits the same kana. */
    fresh_session();
    rime->set_option(session, "full_shape", 1);
    press(',');
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "、") == 0,
          "the full-width mode must keep committing comma as 、");
    rime->set_option(session, "full_shape", 0);
}

/*
 * SPEC: the romaji table matches the shared declaration exactly, including
 * the rows and derivations the stock Kagiroi table lacks and the collisions
 * it spells differently (dotfiles/rime/SPEC.md).
 */
static void test_romanization_matches_declaration(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        /* base rows */
        {"a", "あ"}, {"ka", "か"}, {"si", "し"}, {"tu", "つ"}, {"nu", "ぬ"},
        {"he", "へ"}, {"yu", "ゆ"}, {"ra", "ら"}, {"wa", "わ"}, {"wo", "を"},
        /* rows the stock table lacks: c, q, j, f from the declaration */
        {"ca", "か"}, {"ci", "き"}, {"cu", "く"}, {"ce", "け"}, {"co", "こ"},
        {"qa", "くぁ"}, {"qi", "くぃ"}, {"qe", "くぇ"}, {"qo", "くぉ"},
        {"ja", "じゃ"}, {"ji", "じ"}, {"ju", "じゅ"}, {"je", "じぇ"}, {"jo", "じょ"},
        {"fa", "ふぁ"}, {"fi", "ふぃ"}, {"fu", "ふ"}, {"fe", "ふぇ"}, {"fo", "ふぉ"},
        /* ha/hu/ho yoon spellings (kha=kya, cha is the c row's きゃ) */
        {"kha", "きゃ"}, {"khu", "きゅ"}, {"kho", "きょ"},
        {"sha", "しゃ"}, {"shu", "しゅ"}, {"sho", "しょ"},
        {"cha", "きゃ"}, {"chu", "きゅ"}, {"cho", "きょ"},
        {"zha", "じゃ"}, {"zhu", "じゅ"}, {"zho", "じょ"},
        {"bha", "びゃ"}, {"pha", "ぴゃ"}, {"rhu", "りゅ"},
        /* u-column + small a/i/e/o and o-column + small u families */
        {"kwa", "くぁ"}, {"kwi", "くぃ"}, {"kwe", "くぇ"}, {"kwo", "くぉ"},
        {"hwa", "ふぁ"}, {"cwa", "くぁ"}, {"nwa", "ぬぁ"}, {"bwa", "ぶぁ"},
        {"rwo", "るぉ"},
        {"twu", "とぅ"}, {"dwu", "どぅ"}, {"kwu", "こぅ"}, {"gwu", "ごぅ"},
        {"swu", "そぅ"}, {"rwu", "ろぅ"},
        /* collision spellings resolved to the declaration's kana */
        {"wi", "うぃ"}, {"we", "うぇ"}, {"wyi", "ゐ"}, {"wye", "ゑ"},
        {"va", "ヴぁ"}, {"vu", "ヴ"}, {"vo", "ヴぉ"},
        {"tha", "ちゃ"}, {"thu", "ちゅ"}, {"the", "ちぇ"}, {"tho", "ちょ"},
        {"dha", "ぢゃ"}, {"dhu", "でゅ"}, {"dho", "ぢょ"},
        {"twa", "つぁ"}, {"twi", "つぃ"}, {"twe", "つぇ"}, {"two", "つぉ"},
        {"dwa", "づぁ"}, {"dwe", "づぇ"}, {"dwo", "づぉ"},
        {"khe", "きぇ"}, {"che", "きぇ"}, {"ghe", "ぎぇ"}, {"she", "しぇ"},
        {"thi", "てぃ"}, {"dhi", "でぃ"},
        /* small kana and the katakana row singletons */
        {"la", "ぁ"}, {"lya", "ゃ"}, {"ltu", "っ"}, {"lwa", "ゎ"},
        {"lka", "ヵ"}, {"lke", "ヶ"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        char description[128];
        snprintf(description, sizeof(description),
                 "%s must read %s while composing", cases[i].input, cases[i].expected);
        check(preedit_equals(cases[i].expected), description);
    }
}

/*
 * SPEC: the lone nn stays pending while typing and reads ん when Space
 * resolves the n run (dotfiles/rime/SPEC.md, n の過不足補完).
 */
static void test_nn_resolves_to_n_with_space(void) {
    fresh_session();
    type_text("nn");
    check(preedit_equals("nn"), "the lone nn must stay pending while typing");
    press(kSpace);
    check(preedit_equals("ん"), "nn + Space must read ん");
}

/*
 * SPEC: spellings outside the declaration stay raw; neither the stock
 * kagiroi_romaji table nor its speller/algebra derives are imported
 * (dotfiles/rime/SPEC.md).
 */
static void test_non_declaration_spellings_stay_raw(void) {
    static const char* const cases[] = {
        "chi", "shi", "tsu", "ltsu", "kyi", "kye", "wha", "tsa", "dhe", "fya",
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i]);
        char description[128];
        snprintf(description, sizeof(description),
                 "%s must stay raw because it is not a declaration spelling",
                 cases[i]);
        check(preedit_equals(cases[i]), description);
    }
}

/*
 * SPEC: the sokuon syllables (kk, tt, ...) stay in the dictionary as the
 * input infrastructure outside the declaration; the hatsuon ones do not
 * because the n-run correction pushes ん itself; the long vowel binds to the
 * - key, and the stock q binding is gone (dotfiles/rime/SPEC.md).
 */
static void test_sokuon_hatsuon_and_long_vowel(void) {
    fresh_session();
    type_text("kkanji");
    check(preedit_equals("っかんじ"),
          "kkanji must read っかんじ while composing");
    /* a lone n before a consonant still becomes ん without the nk entries */
    fresh_session();
    type_text("nka");
    check(preedit_equals("んか"), "nka must read んか while composing");
    fresh_session();
    press('-');
    check(preedit_equals("ー"), "- must read ー while composing");
    fresh_session();
    type_text("q");
    check(preedit_equals("q"), "q must stay raw while composing");
}

/*
 * SPEC: typing must not expose any candidates before the first Space.
 *
 * The managed config hides candidates through a Lua gate filter driven by a
 * custom option no librime core handles, so this check exercises the same
 * code path the Windows front-end (librime 1.13.1) runs.
 */
static void test_typing_hides_candidates(void) {
    fresh_session();
    type_text("kanji");
    check(composing(), "typing must start a composition");
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "typing must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates == 0,
          "typing must report zero candidates before the first Space");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "typing must not commit");
}

/*
 * SPEC: the first Space reveals the candidate menu and selects the first
 * candidate without committing.
 */
static void test_first_space_reveals_candidates(void) {
    fresh_session();
    type_text("kanji");
    if (g_verbose) {
        printf("  after typing:\n");
        print_context();
    }
    press(kSpace);
    check(composing(), "first Space must keep the composition open");
    RIME_STRUCT(RimeContext, context);
    check(current_menu(&context) && context.menu.num_candidates > 0,
          "first Space must expose candidates in the menu");
    check(context.menu.highlighted_candidate_index == 0,
          "first Space must select the first candidate");
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "first Space must not commit");
    if (g_verbose) print_context();
}

/* SPEC: later Spaces move the selection and wrap past the final candidate. */
static void test_space_cycles_candidates(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "candidate menu must exist before cycling");
        return;
    }
    int count = context.menu.num_candidates;
    rime->free_context(&context);
    check(count > 1, "the menu must hold more than one candidate for cycling");
    for (int expected = 1; expected <= count; ++expected) {
        press(kSpace);
        if (!rime->get_context(session, &context)) {
            check(False, "the menu must survive cycling");
            return;
        }
        check(context.menu.highlighted_candidate_index == expected % count,
              "Space must advance the highlight and wrap to the first candidate");
        rime->free_context(&context);
    }
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "cycling must not commit");
}

/* SPEC: Enter commits the highlighted candidate. */
static void test_enter_commits_highlighted_candidate(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!rime->get_context(session, &context)) {
        check(False, "the menu must exist before Enter");
        return;
    }
    int highlighted = context.menu.highlighted_candidate_index;
    char expected[256] = "";
    if (highlighted < context.menu.num_candidates && context.menu.candidates[highlighted].text) {
        snprintf(expected, sizeof(expected), "%s", context.menu.candidates[highlighted].text);
    }
    rime->free_context(&context);
    check(expected[0] != '\0', "the highlighted candidate must have text");
    press(kReturn);
    check(composing() == False, "Enter must end the composition");
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "Enter must commit the highlighted candidate");
}

static void on_message(void* context_object, RimeSessionId session_id, const char* message_type, const char* message_value) {
    (void)context_object;
    (void)session_id;
    if (g_verbose) fprintf(stderr, "[%s] %s\n", message_type, message_value);
}

int main(int argc, char* argv[]) {
    const char* user_data_dir = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "-v") == 0) {
            g_verbose = 1;
        } else {
            user_data_dir = argv[i];
        }
    }
    if (!user_data_dir) {
        fprintf(stderr, "usage: harness <user_data_dir> [-v]\n");
        return 2;
    }

    rime = rime_get_api();
    if (!rime) {
        fprintf(stderr, "FAIL: librime is not available\n");
        return 1;
    }

    RIME_STRUCT(RimeTraits, traits);
    traits.shared_data_dir = "/usr/share/rime-data";
    traits.user_data_dir = user_data_dir;
    traits.distribution_name = "dotfiles-rime-test";
    traits.distribution_code_name = "just test-rime";
    traits.distribution_version = "1.0";
    traits.app_name = "rime.kagiroi-behavior-test";
    traits.min_log_level = getenv("RIME_TEST_LOG_LEVEL") ? atoi(getenv("RIME_TEST_LOG_LEVEL")) : 3;
    traits.log_dir = "";

    rime->setup(&traits);
    rime->set_notification_handler(&on_message, NULL);
    rime->initialize(NULL);
    if (!rime->start_maintenance(True)) {
        fprintf(stderr, "FAIL: maintenance did not run\n");
    }
    rime->join_maintenance_thread();

    static void (*const tests[])(void) = {
        test_default_schema_is_kagiroi,
        test_n_run_correction,
        test_n_run_preedit,
        test_n_run_conversion_reading,
        test_kan_space_starts_conversion,
        test_zenkaku_hankaku_toggles_ascii,
        test_henkan_promotes_katakana,
        test_henkan_space_enter_chain,
        test_backspace_escape_return_to_reading,
        test_typing_key_commits_selection,
        test_comma_period_commit_selection,
        test_tab_moves_to_next_candidate,
        test_page_size_is_30,
        test_henkan_typing_key_starts_next_input,
        test_typing_hides_candidates,
        test_first_space_reveals_candidates,
        test_space_cycles_candidates,
        test_enter_commits_highlighted_candidate,
        test_punctuation_commits_directly,
        test_romanization_matches_declaration,
        test_nn_resolves_to_n_with_space,
        test_non_declaration_spellings_stay_raw,
        test_sokuon_hatsuon_and_long_vowel,
    };
    for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); ++i) {
        tests[i]();
    }

    if (session) rime->destroy_session(session);
    rime->finalize();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
