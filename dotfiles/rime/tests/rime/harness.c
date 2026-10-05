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
#define kMuhenkan 0xff22
#define kZenkakuHankaku 0xff2a
#define kShiftL 0xffe1
#define kHiraganaKatakana 0xff27
#define kBackSpace 0xff08
#define kEscape 0xff1b
#define kKeypadDecimal 0xffae
#define kKeypadEnter 0xff8b
#define kKeypad0 0xffb0
#define kKeypad1 0xffb1
#define kTab 0xff09
#define kUp 0xff52
#define kDown 0xff54
#define kLeft 0xff51
#define kRight 0xff53
#define kPageUp 0xff55
#define kPageDown 0xff56
#define kF6 0xffc3
#define kF7 0xffc4
#define kF8 0xffc5
#define kF9 0xffc6
#define kF10 0xffc7

static RimeApi* rime = NULL;
static RimeSessionId session = 0;
static const char* g_user_data_dir = NULL;
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

static void press_shift(int keycode) {
    rime->process_key(session, keycode, 1);
}

static void press_modifier(int keycode, int modifier) {
    rime->process_key(session, keycode, modifier);
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

static Bool without_last_utf8_character(const char* text, char* result, size_t size) {
    size_t length = strlen(text);
    if (length == 0 || size <= length) return False;
    size_t prefix_length = length - 1;
    while (prefix_length > 0 &&
           ((unsigned char)text[prefix_length] & 0xc0) == 0x80) {
        --prefix_length;
    }
    memcpy(result, text, prefix_length);
    result[prefix_length] = '\0';
    return True;
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

static void test_main_dictionary_imports_managed_custom_table(void) {
    RimeConfig dictionary = {0};
    Bool opened = rime->user_config_open("kagiroi.dict", &dictionary);
    check(opened, "the fixture must provide the managed main dictionary");
    if (!opened) return;

    Bool imports_custom = False;
    size_t count = rime->config_list_size(&dictionary, "import_tables");
    for (size_t i = 0; i < count; ++i) {
        char key[64];
        char table[128] = {0};
        snprintf(key, sizeof(key), "import_tables/@%zu", i);
        if (rime->config_get_string(&dictionary, key, table, sizeof(table)) &&
            strcmp(table, "kagiroi.custom") == 0) {
            imports_custom = True;
        }
    }
    check(imports_custom, "the main dictionary must import the managed custom table");
    rime->config_close(&dictionary);
}

/* SPEC: readings with matching dictionary words expose those candidates.
 * Revised literal substitutions are asserted as readings in
 * test_n_run_preedit and test_n_run_conversion_reading, not as folded words. */
static void test_n_run_correction(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"kanji", "漢字"},
        {"kannji", "漢字"},
        {"kana", "かな"},
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

/* SPEC: n-run forms and literal substitutions have their specified readings
 * while composing; trailing pending n/m remains raw until conversion. */
static void test_n_run_preedit(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"nn", "ん"},
        {"gennin", "げんいn"},
        {"nnin", "んいn"},
        {"ni", "に"},
        {"i", "い"},
        {"kann", "かん"},
        {"nna", "んあ"},
        {"nnyo", "んよ"},
        {"kan", "かn"},
        {"kanji", "かんじ"},
        {"kannji", "かんじ"},
        {"kannnji", "かんんじ"},
        {"kannnnji", "かんんじ"},
        {"kannnnu", "かんぬ"},
        {"kannnnyo", "かんんよ"},
        {"kannnni", "かんに"},
        {"kannnne", "かんね"},
        {"kannnno", "かんの"},
        {"nnnn", "んん"},
        {"nt", "んt"},
        {"mt", "んt"},
        {"nm", "んm"},
        {"mn", "んn"},
        {"mm", "ん"},
        {"kana", "かな"},
        {"kanna", "かんあ"},
        {"kannna", "かんな"},
        {"kannnna", "かんな"},
        {"konitiha", "こにちは"},
        {"konnnitiha", "こんにちは"},
        {"kanda", "かんだ"},
        {"kannda", "かんだ"},
        {"kannnda", "かんんだ"},
        {"nya", "にゃ"},
        {"nwa", "んわ"},
        {"nwi", "んうぃ"},
        {"nwe", "んうぇ"},
        {"nwo", "んを"},
        {"kannnen", "かんねn"},
        {"kannnnen", "かんねn"},
        {"kan-", "かnー"},
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

/* SPEC: Space resolves a trailing pending n/m and Esc restores that reading. */
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
    check(context.menu.num_candidates == 0,
          "the first Space must keep the candidate list hidden");
    rime->free_context(&context);
    press(kEscape);
    if (!rime->get_context(session, &context)) {
        check(False, "Esc must keep a queryable context");
        return;
    }
    check(composing(), "Esc must keep the composition open");
    check(context.menu.num_candidates == 0, "Esc must hide the candidate list");
    check(context.composition.preedit && strcmp(context.composition.preedit, "かん") == 0,
          "Esc after n + Space must restore the resolved reading かん");
    rime->free_context(&context);
    press(kReturn);
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "かん") == 0,
          "Enter after n + Space must commit the reading resolved by the conversion");
    check(!composing(), "the commit must end the composition");

    /* Enter commits the displayed reading unchanged; Space/Henkan only resolve
     * a trailing pending n or m (dotfiles/rime/SPEC.md). */
    static const struct {
        const char* input;
        const char* commit_text;
    } raw_commits[] = {
        {"kan", "かn"}, {"kannnna", "かんな"}, {"kannnnji", "かんんじ"},
    };
    for (size_t i = 0; i < sizeof(raw_commits) / sizeof(raw_commits[0]); ++i) {
        fresh_session();
        type_text(raw_commits[i].input);
        press(kReturn);
        char raw_commit[256];
        char raw_description[128];
        snprintf(raw_description, sizeof(raw_description),
                 "%s + Enter must commit the displayed reading %s without correction",
                 raw_commits[i].input, raw_commits[i].commit_text);
        check(take_commit(raw_commit, sizeof(raw_commit))
                  && strcmp(raw_commit, raw_commits[i].commit_text) == 0,
              raw_description);
        check(!composing(), "the raw commit must end the composition");
    }
}

/* SPEC: conversion keys resolve only a trailing pending n or m, even when
 * the caret moved away from the end while typing. */
static void test_conversion_correction_after_caret_move(void) {
    /* Space still resolves a trailing pending n. */
    fresh_session();
    type_text("kan");
    press(kLeft);
    press(kSpace);
    check(composing(), "Space after a caret move must still start the conversion");
    press(kEscape);
    check(preedit_equals("かん"),
          "Space after a caret move must resolve the trailing pending n");

    /* Henkan resolves the same reading before the katakana promotion. */
    fresh_session();
    type_text("kan");
    press(kLeft);
    press(kHenkan);
    check(preedit_equals("カン"),
          "Henkan after a caret move must resolve the trailing pending n");
    press(kEscape);
    check(preedit_equals("かん"), "Esc must restore the resolved reading");

    /* Conversion preserves the already-substituted reading across the whole
     * composition instead of applying postroma again. */
    fresh_session();
    type_text("kannnji");
    press(kLeft);
    press(kSpace);
    check(composing(), "Space after a caret move must keep the conversion open");
    press(kEscape);
    check(preedit_equals("かんんじ"),
          "Space after a caret move must preserve the input-time reading");
}

/* SPEC: Space resolves only trailing pending n/m. Input-time literal
 * substitutions are preserved, with no folding or postroma at conversion.
 * Esc restores that reading. */
static void test_n_run_conversion_reading(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"nn", "ん"},
        {"gennin", "げんいん"},
        {"nnin", "んいん"},
        {"kann", "かん"},
        {"nna", "んあ"},
        {"nnyo", "んよ"},
        {"kan", "かん"},
        {"kanji", "かんじ"},
        {"kannji", "かんじ"},
        {"kannnji", "かんんじ"},
        {"kannnnji", "かんんじ"},
        {"kannnni", "かんに"},
        {"kannnnu", "かんぬ"},
        {"kannnne", "かんね"},
        {"kannnno", "かんの"},
        {"kannnnyo", "かんんよ"},
        {"nnnn", "んん"},
        {"kanda", "かんだ"},
        {"kannda", "かんだ"},
        {"kannnda", "かんんだ"},
        {"kana", "かな"},
        {"nya", "にゃ"},
        {"kanna", "かんあ"},
        {"kannna", "かんな"},
        {"kannnna", "かんな"},
        {"konnnitiha", "こんにちは"},
        {"nwa", "んわ"},
        {"nwi", "んうぃ"},
        {"nwe", "んうぇ"},
        {"nwo", "んを"},
        {"kannnen", "かんねん"},
        {"kannnnen", "かんねん"},
        {"kam", "かん"},
        {"man", "まん"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        press(kSpace);
        press(kEscape);
        char description[128];
        snprintf(description, sizeof(description), "%s must convert with the reading %s",
                 cases[i].input, cases[i].expected);
        check(preedit_equals(cases[i].expected), description);
    }
}

static void test_left_shift_keeps_mode_and_composition(void) {
    static const struct {
        const char* input;
        int mode_key;
        Bool ascii_mode;
        Bool ascii_input;
        const char* preedit;
    } cases[] = {
        {"", 0, False, False, ""},
        {"kana", 0, False, False, "かな"},
        {"kana", kZenkakuHankaku, False, True, "かな"},
        {"", kZenkakuHankaku, True, False, ""},
    };
    const int modifiers[] = {1, 1 << 30};
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        if (cases[i].mode_key) press(cases[i].mode_key);
        for (size_t j = 0; j < sizeof(modifiers) / sizeof(modifiers[0]); ++j) {
            press_modifier(kShiftL, modifiers[j]);
            char description[256];
            snprintf(description, sizeof(description),
                     "left Shift %s in case %zu must keep the mode and unconfirmed text",
                     j == 0 ? "press" : "release", i);
            check(option("ascii_mode") == cases[i].ascii_mode &&
                  option("_kagiroi_ascii_input") == cases[i].ascii_input,
                  description);
            check(*cases[i].preedit ? preedit_equals(cases[i].preedit) : !composing(),
                  description);
            char commit[256];
            check(!take_commit(commit, sizeof(commit)),
                  "left Shift must not commit unconfirmed text");
        }
    }
}

static void test_ahk_shift_l_equal_sequence_stays_japanese(void) {
    const char* inputs[] = {"", "kana"};
    const char* preedits[] = {"＝", "かな＝"};
    for (size_t i = 0; i < sizeof(inputs) / sizeof(inputs[0]); ++i) {
        fresh_session();
        type_text(inputs[i]);
        press_modifier(kShiftL, 1);
        press_modifier(kShiftL, 1 << 30);
        check(!option("ascii_mode") && !option("_kagiroi_ascii_input"),
              "AHK's injected left Shift release must keep Japanese input");
        press('=');
        press_modifier('=', 1 << 30);
        check(preedit_equals(preedits[i]),
              "AHK's injected equal must append an unconfirmed full-width ＝");
        press_modifier(kShiftL, 1);
        press_modifier('l', 1 | (1 << 30));
        check(!option("ascii_mode") && !option("_kagiroi_ascii_input"),
              "AHK's restored left Shift and physical l release must keep Japanese input");
        check(preedit_equals(preedits[i]),
              "AHK's remaining key events must keep the full-width equal preedit");
        char commit[256];
        check(!take_commit(commit, sizeof(commit)),
              "AHK's Shift+l sequence must keep the text unconfirmed");
    }
}

/* SPEC: Zenkaku_Hankaku and Muhenkan with nothing unconfirmed switch IME
 * OFF through the ascii_mode option; Zenkaku_Hankaku toggles the unconfirmed
 * ascii input mode while a composition is open. */
static void test_zenkaku_hankaku_toggles_ascii(void) {
    fresh_session();
    press(kZenkakuHankaku);
    check(option("ascii_mode"), "idle Zenkaku_Hankaku must switch IME OFF");
    check(!option("_kagiroi_ascii_input"),
          "idle Zenkaku_Hankaku must not enter the ascii input mode");
    check(!composing(), "idle Zenkaku_Hankaku must not create a composition");
    static const struct {
        int modifier;
        const char* description;
    } ignored_toggles[] = {
        {1 << 30, "released Zenkaku_Hankaku must keep IME OFF"},
        {1, "Shift+Zenkaku_Hankaku must keep IME OFF"},
        {1 << 2, "Control+Zenkaku_Hankaku must keep IME OFF"},
        {1 << 3, "Alt+Zenkaku_Hankaku must keep IME OFF"},
        {1 << 26, "Super+Zenkaku_Hankaku must keep IME OFF"},
    };
    for (size_t i = 0; i < sizeof(ignored_toggles) / sizeof(ignored_toggles[0]); ++i) {
        press_modifier(kZenkakuHankaku, ignored_toggles[i].modifier);
        check(option("ascii_mode"), ignored_toggles[i].description);
    }
    check(!rime->process_key(session, kMuhenkan, 0),
          "Muhenkan in IME OFF must pass through to the frontend");
    check(option("ascii_mode"), "Muhenkan in IME OFF must keep IME OFF");
    const char* off_text = "a1. ";
    for (const char* p = off_text; *p; ++p) {
        check(!rime->process_key(session, *p, 0),
              "ordinary text in IME OFF must pass through to the frontend");
        check(option("ascii_mode"), "ordinary text must keep IME OFF");
    }
    char commit[256];
    check(!composing(), "other key events in IME OFF must not create a composition");
    check(!take_commit(commit, sizeof(commit)), "other key events in IME OFF must not commit");
    check(rime->process_key(session, kZenkakuHankaku, 0),
          "a second idle Zenkaku_Hankaku must be handled");
    check(!option("ascii_mode"), "a second idle Zenkaku_Hankaku must restore Japanese input");
    check(!option("_kagiroi_ascii_input"), "the idle round trip must not enter the ascii input mode");
    check(!composing(), "the idle round trip must not create a composition");
    press_modifier(kZenkakuHankaku, 1 << 30);
    check(!option("ascii_mode"), "the restored toggle's release must keep Japanese input");
    type_text("kana");
    check(preedit_equals("かな"), "kana after the idle round trip must display Japanese preedit");
    press(kEscape);
    type_text("kanji");
    press(kZenkakuHankaku);
    check(option("_kagiroi_ascii_input"),
          "Zenkaku_Hankaku with a composition must enter the ascii input mode");
    press(kZenkakuHankaku);
    check(!option("_kagiroi_ascii_input"),
          "a second Zenkaku_Hankaku must restore the Japanese mode");
    /* The toggle must also work outside a composition. */
    RIME_STRUCT(RimeStatus, status);
    Bool composing_before = rime->get_status(session, &status) && status.is_composing;
    rime->free_status(&status);
    check(composing_before, "the composition must stay open through the round trip");
    press(kEscape);
    check(!composing(), "Esc must clear the composition after the round trip");
}

/* SPEC: switching to the ascii input mode keeps the composition unconfirmed;
 * half-width typing extends it in place, and the Japanese mode resumes the
 * composition as it is (dotfiles/rime/SPEC.md). */
static void preview_text(char* buffer, size_t size);
static Bool preview_equals(const char* expected);
static Bool menu_hidden(void);
static void selected_text(char* buffer, size_t size);

static void test_zenkaku_hankaku_keeps_composition(void) {
    char commit[256];

    /* Typing state: the reading stays and half-width typing extends it. */
    fresh_session();
    type_text("kanji");
    press(kZenkakuHankaku);
    check(option("_kagiroi_ascii_input"), "Zenkaku_Hankaku must enter the ascii input mode");
    check(composing(), "the toggle must keep the composition");
    check(preedit_equals("かんじ"), "the toggle must keep the reading");
    check(!take_commit(commit, sizeof(commit)), "the toggle must not commit the reading");
    type_text("abc");
    check(option("_kagiroi_ascii_input"), "ascii typing must keep the ascii input mode");
    check(preedit_equals("かんじabc"), "ascii typing must extend the composition in half-width");
    check(!take_commit(commit, sizeof(commit)), "ascii typing must not commit");
    press(kZenkakuHankaku);
    check(!option("_kagiroi_ascii_input"), "Zenkaku_Hankaku must restore the Japanese mode");
    check(preedit_equals("かんじabc"), "the composition must stay for the Japanese mode");
    check(composing(), "the restored composition must keep composing");
    /* The Japanese mode resumes conversion behind the fixed half-width text. */
    press('k');
    press('a');
    check(preedit_equals("かんじabcか"), "typing behind the fixed text must convert");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "かんじabcか") == 0,
          "the composition must commit as a whole");

    /* Converted state: retain the complete display. */
    fresh_session();
    type_text("kanji");
    press(kSpace);
    char display[256];
    preview_text(display, sizeof(display));
    press(kZenkakuHankaku);
    check(option("_kagiroi_ascii_input"), "the toggle must enter the ascii input mode from the conversion");
    check(!take_commit(commit, sizeof(commit)), "the toggle must not commit the conversion");
    check(preview_equals(display), "the toggle must retain the converted display");
    press(kZenkakuHankaku);
    check(!option("_kagiroi_ascii_input"), "the toggle must restore the Japanese mode");
    press(kEscape);
    check(!composing(), "Esc must clear the composition after the round trip");

    /* Henkan state: retain katakana without reinterpreting it. */
    fresh_session();
    type_text("kana");
    press(kHenkan);
    press(kZenkakuHankaku);
    check(option("_kagiroi_ascii_input"), "the toggle must enter the ascii input mode from Henkan");
    check(!take_commit(commit, sizeof(commit)), "the toggle must not commit the Henkan katakana");
    check(preedit_equals("カナ"), "the toggle must retain the Henkan display");
    check(!option("katakana"), "the toggle must restore the kana mode from Henkan");
    press(kZenkakuHankaku);
    check(!option("_kagiroi_ascii_input"), "the toggle must restore the Japanese mode");
    type_text("moji");
    check(preedit_equals("カナもじ"), "typing after the round trip must convert behind the retained display");
}

/* SPEC: Muhenkan switches IME OFF with nothing unconfirmed and enters the
 * unconfirmed ascii input mode from a composition, keeping it unconfirmed. */
static void test_kana_muhenkan_one_way_switches(void) {
    char commit[256];
    fresh_session();
    press(kMuhenkan);
    check(option("ascii_mode"), "idle Muhenkan must switch IME OFF");
    check(!option("_kagiroi_ascii_input"),
          "idle Muhenkan must not enter the ascii input mode");
    check(rime->process_key(session, kZenkakuHankaku, 0),
          "Zenkaku_Hankaku must handle the return from Muhenkan's IME OFF");
    check(!option("ascii_mode"), "Zenkaku_Hankaku must restore Japanese input after idle Muhenkan");

    /* Muhenkan keeps the composition unconfirmed like the toggle. */
    fresh_session();
    type_text("kana");
    press(kMuhenkan);
    check(option("_kagiroi_ascii_input"), "Muhenkan must enter the ascii input mode from a composition");
    check(!take_commit(commit, sizeof(commit)), "Muhenkan must not commit the composition");
    check(preedit_equals("かな"), "Muhenkan must keep the composition");
    type_text("abc");
    check(preedit_equals("かなabc"), "ascii typing must extend the composition in half-width");
    press(kMuhenkan);
    check(option("_kagiroi_ascii_input"),
          "Muhenkan inside the mode must leave the mode untouched");
    check(preedit_equals("かなabc"),
          "Muhenkan inside the mode must keep the composition");
    press(kZenkakuHankaku);
    check(!option("_kagiroi_ascii_input"), "Zenkaku_Hankaku must restore the Japanese mode");
    check(preedit_equals("かなabc"), "the Japanese mode must keep the composition");
    check(composing(), "the restored reading must keep composing");
}

/* SPEC: digits, symbols, punctuation and keypad character keys (Enter
 * excluded) add their character while idle or typing. During conversion
 * they commit the whole displayed composition and start the next input
 * with the character (dotfiles/rime/SPEC.md, "確定と次入力"). */
static void test_digit_and_keypad_symbol_keys(void) {
    static const struct {
        int key;
        const char* appended;
    } cases[] = {
        {'0', "０"}, {'1', "１"}, {'2', "２"}, {'3', "３"}, {'4', "４"},
        {'5', "５"}, {'6', "６"}, {'7', "７"}, {'8', "８"}, {'9', "９"},
        {0xffb0, "0"}, {kKeypad1, "1"}, {0xffb2, "2"}, {0xffb3, "3"},
        {0xffb4, "4"}, {0xffb5, "5"}, {0xffb6, "6"}, {0xffb7, "7"},
        {0xffb8, "8"}, {0xffb9, "9"}, {kKeypadDecimal, "."},
        {0xffac, ","}, {0xffaa, "*"}, {0xffab, "+"}, {0xffad, "-"},
        {0xffaf, "/"}, {0xffbd, "="},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        for (int state = 0; state < 3; ++state) {
            fresh_session();
            if (state > 0) type_text("kanji");
            if (state == 2) {
                press(kSpace);
                press(kSpace);
            }
            char expected[288] = "";
            char selected[256] = "";
            if (state == 2) {
                RIME_STRUCT(RimeContext, context);
                if (current_menu(&context)) {
                    int index = context.menu.highlighted_candidate_index;
                    if (index < context.menu.num_candidates && context.menu.candidates[index].text)
                        snprintf(selected, sizeof(selected), "%s", context.menu.candidates[index].text);
                    rime->free_context(&context);
                }
                check(selected[0] != '\0', "the selection must exist before the character key");
            } else if (state == 1) {
                snprintf(expected, sizeof(expected), "%s", "かんじ");
            }
            press(cases[i].key);
            char commit[256];
            char description[160];
            if (state == 2) {
                /* The key commits the whole display and starts a fresh input. */
                snprintf(expected, sizeof(expected), "%s", cases[i].appended);
                snprintf(description, sizeof(description),
                         "key %x with the list visible must start a fresh input with its character",
                         cases[i].key);
                check(preedit_equals(expected), description);
                check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
                      "a character key with the list visible must commit the whole displayed selection");
                check(!option("_kagiroi_expand_candidates"),
                      "the commit must release candidate expansion");
            } else {
                size_t used = strlen(expected);
                snprintf(expected + used, sizeof(expected) - used, "%s", cases[i].appended);
                snprintf(description, sizeof(description), "key %x in state %d must append its character",
                         cases[i].key, state);
                check(preedit_equals(expected), description);
                snprintf(description, sizeof(description), "key %x in state %d must not commit",
                         cases[i].key, state);
                check(!take_commit(commit, sizeof(commit)), description);
            }
        }
    }

    /* A pending n stays as-is ahead of the appended digit. */
    fresh_session();
    type_text("kan");
    press(kKeypad1);
    check(preedit_equals("かn1"), "a keypad digit must keep a pending n as-is before the digit");

    fresh_session();
    type_text("kanji");
    press(kKeypadEnter);
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "かんじ") == 0,
          "KP_Enter must commit like Enter");
}

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

    /* Henkan resolves trailing pending n/m without folding input-time
     * readings or reapplying literal substitutions. */
    static const struct {
        const char* input;
        const char* katakana;
        const char* reading;
    } n_cases[] = {
        {"kan", "カン", "かん"},
        {"kannnna", "カンナ", "かんな"},
        {"kannnnen", "カンネン", "かんねん"},
        {"kannnnji", "カンンジ", "かんんじ"},
        {"kam", "カン", "かん"},
        {"nnyo", "ンヨ", "んよ"},
    };
    for (size_t i = 0; i < sizeof(n_cases) / sizeof(n_cases[0]); ++i) {
        fresh_session();
        type_text(n_cases[i].input);
        press(kHenkan);
        char katakana_description[128];
        snprintf(katakana_description, sizeof(katakana_description),
                 "%s + Henkan must promote the corrected reading %s",
                 n_cases[i].input, n_cases[i].katakana);
        check(preedit_equals(n_cases[i].katakana), katakana_description);
        press(kEscape);
        char reading_description[128];
        snprintf(reading_description, sizeof(reading_description),
                 "Esc after %s + Henkan must restore the corrected reading %s",
                 n_cases[i].input, n_cases[i].reading);
        check(preedit_equals(n_cases[i].reading), reading_description);
    }
}

/* SPEC: Space after Henkan selects the ordinary first candidate with the
 * list hidden; Enter commits it and the next typing hides candidates again. */
static void test_henkan_space_enter_chain(void) {
    char ordinary_first[256] = "";
    fresh_session();
    type_text("kanji");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (current_menu(&context) && context.composition.preedit) {
        snprintf(ordinary_first, sizeof(ordinary_first), "%s",
                 context.composition.preedit);
        rime->free_context(&context);
    } else {
        rime->free_context(&context);
    }
    check(ordinary_first[0] != '\0',
          "a fresh kanji conversion must show its ordinary first candidate");

    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kHenkan);
    if (!current_menu(&context)) {
        check(False, "the context must exist after Henkan");
        return;
    }
    check(context.menu.num_candidates == 0, "Henkan must keep the menu hidden after Space");
    rime->free_context(&context);
    press(kSpace);
    if (!rime->get_context(session, &context)) {
        check(False, "the conversion must survive Space after Henkan");
        return;
    }
    check(composing(), "Space after Henkan must keep the composition open");
    check(context.menu.num_candidates == 0,
          "Space after Henkan must keep the candidate list hidden");
    check(context.composition.preedit &&
              strcmp(context.composition.preedit, ordinary_first) == 0,
          "Space after Henkan must select the ordinary first candidate");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)),
          "Space after Henkan must not commit the candidate");
    press(kReturn);
    check(composing() == False, "Enter after Henkan must end the composition");
    check(take_commit(commit, sizeof(commit)) &&
              strcmp(commit, ordinary_first) == 0,
          "Enter must commit the ordinary first candidate kept after Henkan");

    fresh_session();
    type_text("kanji");
    press(kHenkan);
    press(kSpace);
    press(kSpace);
    if (current_menu(&context)) {
        check(context.menu.num_candidates > 0,
              "a repeated Space after Henkan must open the candidate list");
        rime->free_context(&context);
    } else {
        check(False, "a repeated Space after Henkan must keep a queryable context");
    }
    check(!take_commit(commit, sizeof(commit)),
          "repeated Space after Henkan must not commit");
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

/* SPEC: Backspace removes the last Unicode character from a converted
 * candidate without committing; Esc restores the reading before Backspace
 * and clears the composition after Backspace. */
static void test_backspace_escape_return_to_reading(void) {
    RIME_STRUCT(RimeContext, context);
    char commit[256];

    /* Backspace with the candidate menu visible deletes the selected candidate's
     * final Unicode character and hides the menu. */
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kSpace);
    char selected[256] = "";
    if (current_menu(&context)) {
        int highlighted = context.menu.highlighted_candidate_index;
        if (highlighted >= 0 && highlighted < context.menu.num_candidates &&
            context.menu.candidates[highlighted].text) {
            snprintf(selected, sizeof(selected), "%s",
                     context.menu.candidates[highlighted].text);
        }
        rime->free_context(&context);
    } else {
        check(False, "the visible candidate menu must keep a queryable context");
    }
    char after_backspace[256] = "";
    check(selected[0] != '\0', "the selected candidate must have text");
    check(without_last_utf8_character(selected, after_backspace,
                                       sizeof(after_backspace)),
          "the selected candidate must contain a Unicode character to delete");
    press(kBackSpace);
    if (!current_menu(&context)) {
        check(False, "Backspace must keep a queryable context");
        return;
    }
    check(composing(), "Backspace must keep the composition open");
    check(context.menu.num_candidates == 0, "Backspace must hide the candidate list");
    check(context.composition.preedit &&
              strcmp(context.composition.preedit, after_backspace) == 0,
          "Backspace must delete the selected candidate's last Unicode character");
    rime->free_context(&context);
    check(!take_commit(commit, sizeof(commit)), "Backspace must not commit");

    /* A subsequent Backspace deletes one more Unicode character. */
    char after_second_backspace[256] = "";
    check(without_last_utf8_character(after_backspace, after_second_backspace,
                                      sizeof(after_second_backspace)),
          "the remaining candidate text must contain another character");
    press(kBackSpace);
    check(after_second_backspace[0] ? preedit_equals(after_second_backspace) : !composing(),
          "a subsequent Backspace must delete one more Unicode character");
    check(!take_commit(commit, sizeof(commit)),
          "a subsequent Backspace must not commit");

    /* Esc before Backspace restores the reading; Backspace then edits it. */
    fresh_session();
    type_text("kana");
    press(kSpace);
    press(kEscape);
    check(preedit_equals("かな"), "Esc before Backspace must restore the reading");
    press(kBackSpace);
    check(preedit_equals("か"),
          "Backspace after Esc must delete the reading's last character");

    /* Backspace from the hidden first-Space conversion, then Space reconverts. */
    fresh_session();
    type_text("kana");
    press(kSpace);
    char inline_candidate[256] = "";
    if (current_menu(&context)) {
        if (context.composition.preedit) {
            snprintf(inline_candidate, sizeof(inline_candidate), "%s",
                     context.composition.preedit);
        }
        check(context.menu.num_candidates == 0,
              "the first Space must keep the candidate list hidden");
        rime->free_context(&context);
    } else {
        check(False, "the hidden conversion must keep a queryable context");
    }
    char hidden_remainder[256] = "";
    check(without_last_utf8_character(inline_candidate, hidden_remainder,
                                      sizeof(hidden_remainder)),
          "the inline candidate must contain a Unicode character to delete");
    press(kBackSpace);
    check(preedit_equals(hidden_remainder),
          "Backspace in the hidden conversion must delete its last character");
    press(kSpace);
    check(composing(), "Space after Backspace must reconvert the remainder");
    if (current_menu(&context)) {
        check(context.menu.num_candidates == 0,
              "Space after Backspace must keep the candidate list hidden");
        rime->free_context(&context);
    } else {
        check(False, "Space after Backspace must keep a queryable context");
    }
    check(!take_commit(commit, sizeof(commit)),
          "Space after Backspace must not commit the reconverted remainder");

    /* Henkan's inline katakana candidate follows the same Backspace rule. */
    fresh_session();
    type_text("kana");
    press(kHenkan);
    char henkan_candidate[256] = "";
    if (current_menu(&context)) {
        if (context.composition.preedit) {
            snprintf(henkan_candidate, sizeof(henkan_candidate), "%s",
                     context.composition.preedit);
        }
        rime->free_context(&context);
    }
    char henkan_remainder[256] = "";
    check(without_last_utf8_character(henkan_candidate, henkan_remainder,
                                      sizeof(henkan_remainder)),
          "the Henkan candidate must contain a Unicode character to delete");
    press(kBackSpace);
    check(preedit_equals(henkan_remainder),
          "Backspace after Henkan must delete the candidate's last character");
    if (current_menu(&context)) {
        check(context.menu.num_candidates == 0,
              "Backspace after Henkan must hide the candidate list");
        rime->free_context(&context);
    } else {
        check(False, "Backspace after Henkan must keep a queryable context");
    }
    check(!take_commit(commit, sizeof(commit)), "Backspace after Henkan must not commit");
    press(kEscape);
    check(!composing(), "Esc after Backspace must clear the remaining composition");
    check(!take_commit(commit, sizeof(commit)), "Esc after Backspace must not commit");

    /* Deleting Henkan's one-character candidate leaves nothing to compose. */
    fresh_session();
    type_text("a");
    press(kHenkan);
    if (current_menu(&context)) {
        check(context.composition.preedit &&
                  strcmp(context.composition.preedit, "ア") == 0,
              "Henkan must show the one-character katakana candidate");
        check(context.menu.num_candidates == 0,
              "Henkan must keep the one-character candidate menu hidden");
        rime->free_context(&context);
    } else {
        check(False, "the one-character Henkan candidate must keep a queryable context");
    }
    press(kBackSpace);
    check(!composing(), "Backspace must clear a one-character converted candidate");
    Bool has_context = current_menu(&context);
    check(!has_context || context.menu.num_candidates == 0,
          "Backspace must leave no candidates or menu after deleting the only character");
    if (has_context) rime->free_context(&context);
    check(!take_commit(commit, sizeof(commit)),
          "Backspace must not commit a deleted one-character candidate");

    /* Backspace edits the ordinary first candidate selected by Space after
     * Henkan. */
    char ordinary_first[256] = "";
    fresh_session();
    type_text("kanji");
    press(kSpace);
    if (current_menu(&context) && context.composition.preedit) {
        snprintf(ordinary_first, sizeof(ordinary_first), "%s",
                 context.composition.preedit);
        rime->free_context(&context);
    } else {
        rime->free_context(&context);
    }
    char ordinary_remainder[256] = "";
    check(ordinary_first[0] != '\0' &&
              without_last_utf8_character(ordinary_first, ordinary_remainder,
                                          sizeof(ordinary_remainder)),
          "the ordinary first candidate must contain a character to delete");
    fresh_session();
    type_text("kanji");
    press(kHenkan);
    press(kSpace);
    if (current_menu(&context)) {
        check(context.menu.num_candidates == 0 &&
                  context.composition.preedit &&
                  strcmp(context.composition.preedit, ordinary_first) == 0,
              "Space after Henkan must select the ordinary first candidate hidden");
        rime->free_context(&context);
    } else {
        check(False, "the kept Henkan conversion must keep a queryable context");
    }
    press(kBackSpace);
    check(preedit_equals(ordinary_remainder),
          "Backspace after Henkan and Space must delete the first candidate's last character");
    if (current_menu(&context)) {
        check(context.menu.num_candidates == 0,
              "Backspace after the kept conversion must hide candidates");
        rime->free_context(&context);
    } else {
        check(False, "Backspace after the kept conversion must keep a queryable context");
    }
    check(!take_commit(commit, sizeof(commit)), "Backspace after the kept conversion must not commit");
}

/* SPEC: a letter or digit key during conversion confirms the selected
 * candidate and starts the next input; digits never pick candidates. */
static void test_typing_key_confirms_selection(void) {
    /* A letter key confirms the selection and starts the next reading. */
    fresh_session();
    type_text("kana");
    press(kSpace);
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    char selected[256] = "";
    if (current_menu(&context)) {
        int highlighted = context.menu.highlighted_candidate_index;
        if (highlighted < context.menu.num_candidates &&
            context.menu.candidates[highlighted].text) {
            snprintf(selected, sizeof(selected), "%s",
                     context.menu.candidates[highlighted].text);
        }
        rime->free_context(&context);
    } else {
        check(False, "the menu must exist before the typing key");
    }
    check(selected[0] != '\0', "the highlighted candidate must have text");
    press('k');
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
          "a typing key must confirm the selected candidate");
    check(preedit_equals("k"), "the typing key must start the next reading");
    if (!current_menu(&context)) {
        check(False, "the next reading must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates == 0,
          "the next reading must hide the candidate list");
    rime->free_context(&context);

    /* A digit confirms the highlighted candidate and appends its full-width
     * form to a fresh input. */
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
    snprintf(selected, sizeof(selected), "%s",
             context.menu.candidates[context.menu.highlighted_candidate_index].text
                 ? context.menu.candidates[context.menu.highlighted_candidate_index].text
                 : "");
    rime->free_context(&context);
    check(selected[0] != '\0', "the cycled candidate must have text");
    press('1');
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
          "a digit must confirm the highlighted candidate");
    check(preedit_equals("１"),
          "a digit must start a fresh input with the full-width digit");
}

/*
 * SPEC: comma and period during conversion follow "commit and restart":
 * the whole displayed composition is committed and the punctuation starts
 * the next input as fresh preconversion text
 * (dotfiles/rime/SPEC.md, "確定と次入力").
 */
static void test_punctuation_commits_and_restarts(void) {
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
        char selected[256] = "";
        if (current_menu(&context)) {
            int highlighted = context.menu.highlighted_candidate_index;
            if (highlighted < context.menu.num_candidates &&
                context.menu.candidates[highlighted].text) {
                snprintf(selected, sizeof(selected), "%s",
                         context.menu.candidates[highlighted].text);
            }
            rime->free_context(&context);
        } else {
            check(False, "the menu must exist before the punctuation key");
        }
        check(selected[0] != '\0', "the highlighted candidate must have text");
        press(cases[i].key);
        char commit[256];
        char description[160];
        snprintf(description, sizeof(description),
                 "%s with the menu visible must commit the whole displayed selection",
                 cases[i].name);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
              description);
        snprintf(description, sizeof(description),
                 "%s with the menu visible must start a fresh input with %s",
                 cases[i].name, cases[i].punct);
        check(preedit_equals(cases[i].punct), description);
        check(menu_hidden() && composing(),
              "the punctuation restart must close the list and keep composing");
        check(!option("_kagiroi_expand_candidates"),
              "the punctuation commit must release candidate expansion");
    }

    /* The same from the hidden conversion after the first Space. */
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text("kanji");
        press(kSpace);
        RIME_STRUCT(RimeContext, context);
        char first[256] = "";
        if (current_menu(&context)) {
            if (context.menu.num_candidates == 0 && context.composition.preedit) {
                snprintf(first, sizeof(first), "%s", context.composition.preedit);
            }
            rime->free_context(&context);
        }
        check(first[0] != '\0', "the inline conversion must show its text");
        press(cases[i].key);
        char commit[256];
        char description[160];
        snprintf(description, sizeof(description),
                 "%s after the first Space must commit the inline display",
                 cases[i].name);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, first) == 0,
              description);
        snprintf(description, sizeof(description),
                 "%s after the first Space must start a fresh input with %s",
                 cases[i].name, cases[i].punct);
        check(preedit_equals(cases[i].punct) && menu_hidden(), description);
        check(!take_commit(commit, sizeof(commit)),
              "the restart must leave the fresh punctuation uncommitted");
    }
}

/* SPEC: the first visible Tab expands ten candidates to thirty without
 * changing the selection; a second Tab does nothing; Shift+Tab collapses the
 * expanded list back to ten and does nothing before the expand. */
static void test_tab_expands_candidates(void) {
    fresh_session();
    type_text("kanji");
    press(kTab);
    check(!option("_kagiroi_expand_candidates"), "Tab while typing must not expand");
    press(kSpace);
    press(kTab);
    check(!option("_kagiroi_expand_candidates"), "Tab after the first Space must not expand");
    rime->process_key(session, kTab, 1);
    check(!option("_kagiroi_expand_candidates"), "Shift+Tab before the reveal must do nothing");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "the menu must exist before Tab");
        return;
    }
    check(context.menu.num_candidates <= 10, "the initial menu must have at most ten candidates");
    check(context.menu.highlighted_candidate_index == 1,
          "the reveal must select the second candidate before Tab");
    rime->free_context(&context);
    rime->process_key(session, kTab, 1);
    check(!option("_kagiroi_expand_candidates"), "Shift+Tab before the expand must do nothing");
    if (!current_menu(&context)) {
        check(False, "the menu must survive the pre-expand Shift+Tab");
        return;
    }
    check(context.menu.highlighted_candidate_index == 1,
          "the pre-expand Shift+Tab must keep the selection");
    rime->free_context(&context);
    press(kTab);
    if (!current_menu(&context)) {
        check(False, "the menu must survive Tab");
        return;
    }
    check(composing(), "Tab must keep the composition open");
    check(option("_kagiroi_expand_candidates"), "the first visible Tab must expand the menu");
    check(context.menu.num_candidates == 30, "the expanded menu must hold thirty candidates");
    check(context.menu.highlighted_candidate_index == 1,
          "the first visible Tab must keep the selection");
    rime->free_context(&context);
    press(kTab);
    if (!current_menu(&context)) {
        check(False, "the menu must survive the second Tab");
        return;
    }
    check(context.menu.highlighted_candidate_index == 1,
          "the second Tab must not move the selection");
    check(context.menu.num_candidates == 30, "the second Tab must keep the expansion");
    rime->free_context(&context);
    rime->process_key(session, kTab, 1);
    if (!current_menu(&context)) {
        check(False, "the menu must survive Shift+Tab");
        return;
    }
    check(context.menu.num_candidates <= 10, "Shift+Tab must collapse back to ten");
    check(context.menu.highlighted_candidate_index == 1,
          "Shift+Tab must keep the selection while collapsing");
    rime->free_context(&context);
    rime->process_key(session, kTab, 1);
    if (!current_menu(&context)) {
        check(False, "the menu must survive the collapsed Shift+Tab");
        return;
    }
    check(context.menu.num_candidates <= 10, "a collapsed Shift+Tab must keep ten");
    check(context.menu.highlighted_candidate_index == 1,
          "a collapsed Shift+Tab must keep the selection");
    rime->free_context(&context);
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the menu must survive Space after the collapse");
        return;
    }
    check(context.menu.highlighted_candidate_index == 2,
          "Space must cycle the selection after the collapse");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "Tab must not commit");
    press(kBackSpace);
    check(!option("_kagiroi_expand_candidates"), "Backspace must reset expansion");
    press(kSpace);
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the menu must reopen after Backspace");
        return;
    }
    check(context.menu.num_candidates <= 10, "the next menu must begin collapsed");
    rime->free_context(&context);
    press(kTab);
    press(kEscape);
    check(!option("_kagiroi_expand_candidates"), "Esc must reset expansion");
}

static void test_page_size_is_30(void) {
    fresh_session();
    type_text("ka");
    press(kSpace);
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "the menu must exist for the page size check");
        return;
    }
    if (g_verbose) print_context();
    check(context.menu.num_candidates == 10,
          "a reading with many candidates must initially show exactly ten");
    check(context.menu.candidates[0].comment &&
              strstr(context.menu.candidates[0].comment, "Page 1"),
          "the first collapsed candidate must show Page 1");
    rime->free_context(&context);
    press(kTab);
    if (!current_menu(&context)) {
        check(False, "the menu must survive expansion");
        return;
    }
    if (g_verbose) print_context();
    check(context.menu.num_candidates == 30,
          "a reading with many candidates must show thirty after Tab");
    check(context.select_labels && strcmp(context.select_labels[0], "1") == 0 &&
              strcmp(context.select_labels[29], "30") == 0,
          "the first page must expose labels 1 through 30");
    check(context.menu.candidates[0].comment &&
              strstr(context.menu.candidates[0].comment, "Page 1"),
          "the expanded first page must show Page 1 on its first candidate");
    rime->free_context(&context);
    press(kPageDown);
    if (!current_menu(&context)) {
        check(False, "the menu must survive paging");
        return;
    }
    if (g_verbose) print_context();
    check(context.menu.page_no == 1 && context.menu.highlighted_candidate_index == 0,
          "PageDown must select the next page's first candidate");
    check(context.select_labels && strcmp(context.select_labels[0], "1") == 0 &&
              strcmp(context.select_labels[29], "30") == 0,
          "the next page must restart labels at 1 through 30");
    check(context.menu.candidates[0].comment &&
              strstr(context.menu.candidates[0].comment, "Page 2"),
          "the first candidate on the next page must show Page 2");
    rime->free_context(&context);
    press(kPageUp);
    if (!current_menu(&context)) {
        check(False, "the menu must survive paging back");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 0 &&
              context.select_labels && strcmp(context.select_labels[0], "1") == 0,
          "PageUp must select the first page's head and its labels");
    rime->free_context(&context);
    press(kReturn);
    char commit[256];
    check(take_commit(commit, sizeof(commit)), "Enter must commit the selection");
    check(!option("_kagiroi_expand_candidates"), "a commit must reset expansion");
    type_text("ka");
    press(kSpace);
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the next reading must have a menu");
        return;
    }
    check(context.menu.num_candidates > 0 && context.menu.num_candidates <= 10,
          "the next reading must begin with a nonempty collapsed menu");
    rime->free_context(&context);
}

/* SPEC: PageUp/PageDown page over the whole candidate count at the display
 * width (ten collapsed, thirty expanded), select the destination page's
 * first candidate, cycle between the first and last pages, and a single
 * page still selects its own head (dotfiles/rime/SPEC.md, "候補選択の循環"). */
static void test_page_cycling_selects_heads(void) {
    fresh_session();
    type_text("ka");
    press(kSpace);
    press(kSpace);
    press(kTab);
    char choices[512][256];
    int total = 0;
    RimeCandidateListIterator iterator = {0};
    if (!rime->candidate_list_begin(session, &iterator)) {
        check(False, "the complete candidate iterator must be available");
        return;
    }
    while (total < 512 && rime->candidate_list_next(&iterator)) {
        snprintf(choices[total++], sizeof(choices[0]), "%s", iterator.candidate.text);
    }
    rime->candidate_list_end(&iterator);
    check(total > 30, "ka must hold more than one expanded page");
    if (total <= 30) return;
    int last_collapsed = (total - 1) / 10;
    int last_expanded = (total - 1) / 30;

    /* Collapse back to the ten-wide windows and cycle them. */
    press_shift(kTab);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "collapsing must keep the menu readable");
        return;
    }
    check(context.menu.highlighted_candidate_index == 1,
          "collapsing must keep the second candidate selected");
    rime->free_context(&context);
    press(kPageUp);
    if (!current_menu(&context)) {
        check(False, "collapsed PageUp must preserve the menu");
        return;
    }
    check(context.menu.highlighted_candidate_index == 0 &&
              context.menu.candidates[0].text &&
              strcmp(context.menu.candidates[0].text, choices[last_collapsed * 10]) == 0,
          "collapsed PageUp before the first window must wrap to the last window's head");
    check(context.menu.num_candidates == total - last_collapsed * 10,
          "the last collapsed window must hold only the remaining candidates");
    rime->free_context(&context);
    press(kPageDown);
    if (!current_menu(&context)) {
        check(False, "collapsed PageDown must preserve the menu");
        return;
    }
    check(context.menu.highlighted_candidate_index == 0 &&
              context.menu.candidates[0].text &&
              strcmp(context.menu.candidates[0].text, choices[0]) == 0,
          "collapsed PageDown past the last window must wrap to the first head");
    rime->free_context(&context);
    press(kPageDown);
    press(kPageDown);
    if (!current_menu(&context)) {
        check(False, "collapsed paging must preserve the menu");
        return;
    }
    check(context.menu.highlighted_candidate_index == 0 &&
              context.menu.candidates[0].text &&
              strcmp(context.menu.candidates[0].text, choices[20]) == 0,
          "collapsed PageDown must advance by ten and select the window head");
    check(context.menu.candidates[0].comment &&
              strstr(context.menu.candidates[0].comment, "Page 3"),
          "the third collapsed window must number Page 3 in the final order");
    rime->free_context(&context);

    /* Expanding keeps the selection, and expanded paging cycles 30-wide. */
    press(kTab);
    press(kPageUp);
    if (!current_menu(&context)) {
        check(False, "expanded PageUp must preserve the menu");
        return;
    }
    check(context.menu.page_no == last_expanded && context.menu.highlighted_candidate_index == 0 &&
              context.menu.candidates[0].text &&
              strcmp(context.menu.candidates[0].text, choices[last_expanded * 30]) == 0,
          "expanded PageUp before the first page must wrap to the last page's head");
    rime->free_context(&context);
    press(kPageDown);
    if (!current_menu(&context)) {
        check(False, "expanded PageDown must preserve the menu");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 0 &&
              context.menu.candidates[0].text &&
              strcmp(context.menu.candidates[0].text, choices[0]) == 0,
          "expanded PageDown past the last page must wrap to the first page's head");
    rime->free_context(&context);

    /* A clause with a single page still selects its own head. */
    fresh_session();
    type_text("kanji");
    press(kKeypad1);
    press(kSpace);
    press(kRight);
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the digit clause must expose a menu");
        return;
    }
    check(context.menu.num_candidates >= 2 && context.menu.num_candidates <= 10 &&
              context.menu.highlighted_candidate_index == 1,
          "the reveal must select the digit clause's second candidate");
    rime->free_context(&context);
    press(kPageDown);
    if (!current_menu(&context)) {
        check(False, "single-page PageDown must preserve the menu");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 0,
          "PageDown on a single page must still select the page head");
    rime->free_context(&context);
    press(kPageUp);
    if (!current_menu(&context)) {
        check(False, "single-page PageUp must preserve the menu");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 0,
          "PageUp on a single page must still select the page head");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "paging must not commit");
}

/* SPEC: an ordinary key after Henkan confirms the katakana and starts the
 * next input without opening the candidate list. */
static void test_henkan_typing_key_confirms(void) {
    static const struct {
        int key;
        const char* appended;
        const char* description;
    } cases[] = {
        {'k', "k", "letter"},
        {'1', "１", "digit"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text("kanji");
        press(kHenkan);
        press(cases[i].key);
        char expected[256];
        snprintf(expected, sizeof(expected), "%s", cases[i].appended);
        char description[128];
        snprintf(description, sizeof(description), "Henkan then %s must start a fresh input",
                 cases[i].description);
        check(preedit_equals(expected), description);
        char commit[256];
        snprintf(description, sizeof(description), "Henkan then %s must commit the katakana",
                 cases[i].description);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, "カンジ") == 0,
              description);
    }
}

/*
 * SPEC: in the Japanese mode comma and period append 、 and 。to the
 * unconfirmed composition while idle (dotfiles/rime/SPEC.md).
 */
static void test_punctuation_appends_unconfirmed(void) {
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
        char description[128];
        snprintf(description, sizeof(description),
                 "%s while idle must append %s unconfirmed",
                 cases[i].name, cases[i].expected);
        check(preedit_equals(cases[i].expected), description);
        char commit[256];
        snprintf(description, sizeof(description),
                 "%s while idle must not commit", cases[i].name);
        check(!take_commit(commit, sizeof(commit)), description);
    }
    /* full_shape keeps the same appended character. */
    fresh_session();
    rime->set_option(session, "full_shape", 1);
    press(',');
    check(preedit_equals("、"), "full_width mode must keep appending comma as 、");
    rime->set_option(session, "full_shape", 0);
}

static void test_idle_space_commits_full_width(void) {
    fresh_session();
    press(kSpace);
    check(!composing(), "idle Space must keep the composition empty");
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "　") == 0,
          "idle Space must commit the full-width space immediately");
    press(kSpace);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "　") == 0,
          "a later idle Space must commit another full-width space");
}

/* SPEC: symbol keys append the table character to the unconfirmed
 * composition without opening a candidate list or committing. */
static void test_symbols_append_unconfirmed(void) {
    static const struct { int key; const char* appended; } cases[] = {
        {'!', "！"}, {'@', "＠"}, {'#', "＃"}, {'$', "＄"},
        {'%', "％"}, {'^', "＾"}, {'&', "＆"}, {'*', "＊"},
        {'(', "（"}, {')', "）"}, {'_', "＿"}, {'+', "＋"},
        {'=', "＝"}, {'<', "＜"}, {'>', "＞"}, {'?', "？"},
        {';', "；"}, {':', "："}, {'`', "｀"},
        {'/', "・"}, {'\\', "￥"}, {'~', "〜"}, {'|', "·"},
        {'[', "「"}, {']', "」"}, {'{', "『"}, {'}', "』"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        press(cases[i].key);
        char description[128];
        snprintf(description, sizeof(description), "symbol %x must append %s", cases[i].key, cases[i].appended);
        check(preedit_equals(cases[i].appended), description);
        char commit[256];
        snprintf(description, sizeof(description), "symbol %x must not commit", cases[i].key);
        check(!take_commit(commit, sizeof(commit)), description);
    }
    /* A symbol following a reading keeps it unconfirmed. */
    fresh_session();
    type_text("kana");
    press('$');
    check(preedit_equals("かな＄"), "dollar after a reading must append ＄ unconfirmed");

    /* full_shape does not change the appended symbol. */
    fresh_session();
    rime->set_option(session, "full_shape", 1);
    press('$');
    check(preedit_equals("＄"), "full_shape dollar must append ＄");
    rime->set_option(session, "full_shape", 0);
}

/* SPEC: consecutive appends accumulate in one unconfirmed composition. The
 * Shift+letter entry starts the unconfirmed ascii input mode, so the
 * following symbol stays half-width (dotfiles/rime/SPEC.md). */
static void test_appends_accumulate(void) {
    fresh_session();
    press('1');
    press('$');
    check(preedit_equals("１＄"), "a digit then a symbol must accumulate");
    press(',');
    check(preedit_equals("１＄、"), "punctuation must keep accumulating");
    fresh_session();
    press_shift('A');
    press('=');
    check(preedit_equals("A="), "Shift+letter then a symbol must accumulate in half-width");
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "appends must not commit on their own");
}

/* SPEC: a Space on an appended string without a convertible reading
 * converts it to itself without committing (dotfiles/rime/SPEC.md). */
static void test_space_after_append_converts_uncommitted(void) {
    fresh_session();
    type_text("kanji");
    press(kKeypad1);
    press(kSpace);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)),
          "Space on an appended string must not commit it");
    check(composing(), "the appended string must stay unconfirmed");
    RIME_STRUCT(RimeContext, context);
    if (current_menu(&context)) {
        check(context.menu.num_candidates == 0,
              "the first Space on an appended string must keep the list hidden");
        rime->free_context(&context);
    }
    /* Right selects the appended digit clause before Space opens its menu. */
    press(kRight);
    press(kSpace);
    if (current_menu(&context)) {
        check(context.menu.num_candidates > 0,
              "the second Space must reveal the appended string's candidates");
        check(menu_has_candidate(&context, "1") && menu_has_candidate(&context, "１"),
              "the revealed menu must contain the digit's width forms");
        rime->free_context(&context);
    } else {
        check(False, "the second Space must keep a queryable context");
    }
    check(!take_commit(commit, sizeof(commit)), "the reveal must not commit");
}

/* SPEC: romaji after keypad digits resumes kana input while preserving the
 * appended half-width digits unconfirmed (dotfiles/rime/SPEC.md). */
static void test_romaji_after_keypad_digits_resumes_kana(void) {
    static const struct { const char* input; const char* kana; } syllables[] = {
        {"a", "あ"}, {"i", "い"}, {"u", "う"}, {"e", "え"}, {"o", "お"},
        {"ka", "か"},
    };
    static const struct { const char* input; const char* kana; } prefixes[] = {
        {"", ""}, {"kanji", "かんじ"},
    };
    for (size_t p = 0; p < sizeof(prefixes) / sizeof(prefixes[0]); ++p) {
        for (int digit = 0; digit <= 9; ++digit) {
            for (int count = 1; count <= 2; ++count) {
                for (size_t s = 0; s < sizeof(syllables) / sizeof(syllables[0]); ++s) {
                    fresh_session();
                    type_text(prefixes[p].input);
                    char digits[3] = {0};
                    for (int d = 0; d < count; ++d) {
                        press(kKeypad0 + digit);
                        digits[d] = '0' + digit;
                    }
                    type_text(syllables[s].input);
                    char expected[64], description[256], commit[256];
                    snprintf(expected, sizeof(expected), "%s%s%s",
                             prefixes[p].kana, digits, syllables[s].kana);
                    snprintf(description, sizeof(description),
                             "%s + KP digits %s + %s must read %s; input is %s",
                             prefixes[p].input, digits, syllables[s].input,
                             expected, rime->get_input(session));
                    check(preedit_equals(expected), description);
                    snprintf(description, sizeof(description),
                             "%s + KP digits %s + %s must keep composing",
                             prefixes[p].input, digits, syllables[s].input);
                    check(composing(), description);
                    snprintf(description, sizeof(description),
                             "%s + KP digits %s + %s must not commit",
                             prefixes[p].input, digits, syllables[s].input);
                    check(!take_commit(commit, sizeof(commit)), description);
                }
            }
        }
    }
}

/* SPEC: a full-width digit appended by a main-row key is not reading
 * alphabet; romaji typed after it converts behind it
 * (dotfiles/rime/SPEC.md, "操作例"). */
static void test_fullwidth_digit_then_romaji_suffix(void) {
    fresh_session();
    type_text("ka");
    press('1');
    type_text("ki");
    check(preedit_equals("か１き"), "か１k + i must read か１き");
    press(kSpace);
    check(composing(), "Space must convert the mixed reading");
    press(kEscape);
    check(preedit_equals("か１き"), "Esc must restore the mixed reading");
    char commit[256];
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "か１き") == 0,
          "Enter must commit the mixed reading as displayed");
    check(!composing(), "the commit must end the composition");
}

/* SPEC: returning from ascii input preserves its raw tail and converts only
 * newly typed romaji to kana (dotfiles/rime/SPEC.md). */
static void test_ascii_keypad_vowels_preserved_on_kana_resumption(void) {
    static const struct { int key; const char* kana; } vowels[] = {
        {'a', "あ"}, {'i', "い"}, {'u', "う"}, {'e', "え"}, {'o', "お"},
    };
    for (size_t i = 0; i < sizeof(vowels) / sizeof(vowels[0]); ++i) {
        fresh_session();
        type_text("kanji");
        press(kZenkakuHankaku);
        check(option("_kagiroi_ascii_input"), "the test must enter ascii input");
        press(kKeypad1);
        press(vowels[i].key);
        char expected[64], description[256], commit[256];
        snprintf(expected, sizeof(expected), "かんじ1%c", vowels[i].key);
        snprintf(description, sizeof(description),
                 "ascii KP_1 + %c must stay raw as %s; input is %s",
                 vowels[i].key, expected, rime->get_input(session));
        check(preedit_equals(expected), description);
        check(composing(), "ascii keypad/vowel input must keep composing");
        check(!take_commit(commit, sizeof(commit)), "ascii keypad/vowel input must not commit");
        press(kZenkakuHankaku);
        check(!option("_kagiroi_ascii_input"), "the test must return to Japanese input");
        press(vowels[i].key);
        snprintf(expected, sizeof(expected), "かんじ1%c%s", vowels[i].key, vowels[i].kana);
        snprintf(description, sizeof(description),
                 "new %c must resume kana with the raw tail intact as %s; input is %s",
                 vowels[i].key, expected, rime->get_input(session));
        check(preedit_equals(expected), description);
        check(composing(), "kana resumption must keep composing");
        check(!take_commit(commit, sizeof(commit)), "kana resumption must not commit");
    }
}

/* SPEC: quote keys append the opening and closing marks as a pair. */
static void test_quote_pairs(void) {
    static const struct { int key; const char* pair; } cases[] = {
        {'\'', "‘’"}, {'"', "“”"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        press(cases[i].key);
        char description[128];
        snprintf(description, sizeof(description), "quote %x must append the pair", cases[i].key);
        check(preedit_equals(cases[i].pair), description);
        press(cases[i].key);
        char doubled[16];
        snprintf(doubled, sizeof(doubled), "%s%s", cases[i].pair, cases[i].pair);
        snprintf(description, sizeof(description), "a second quote %x must append another pair", cases[i].key);
        check(preedit_equals(doubled), description);
    }
}

/* SPEC: - and = during conversion commit the whole displayed selection and
 * restart the input with their character instead of paging; a minus while
 * reading appends ー (dotfiles/rime/SPEC.md, "確定と次入力"). */
static void test_minus_equal_commit_and_restart(void) {
    static const struct { int key; const char* symbol; } cases[] = {
        {'-', "ー"}, {'=', "＝"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text("kanji");
        press(kSpace);
        press(kSpace);
        RIME_STRUCT(RimeContext, context);
        char selected[256] = "";
        if (current_menu(&context)) {
            int index = context.menu.highlighted_candidate_index;
            if (index < context.menu.num_candidates && context.menu.candidates[index].text)
                snprintf(selected, sizeof(selected), "%s", context.menu.candidates[index].text);
            rime->free_context(&context);
        }
        check(selected[0] != '\0', "the highlighted candidate must exist");
        press(cases[i].key);
        char commit[256];
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
              "minus/equal must commit the whole displayed selection");
        check(preedit_equals(cases[i].symbol),
              "minus/equal must restart the input with its character");
        check(menu_hidden() && composing(),
              "the restart must close the list and keep composing");
        check(!option("_kagiroi_expand_candidates"),
              "the commit must release candidate expansion");
    }
    fresh_session();
    type_text("kana");
    press('-');
    check(preedit_equals("かなー"), "minus during reading must append ー");
}

/* SPEC: the ascii input mode appends half-width letters, digits, symbols,
 * the space and every keypad symbol to the unconfirmed composition
 * (dotfiles/rime/SPEC.md). */
static void test_ascii_mode_passes_half_width_keys(void) {
    fresh_session();
    press_shift('A');
    check(option("_kagiroi_ascii_input"),
          "the test must enter the ascii input mode before typing");
    const int keys[] = {'a', '1', '$', kSpace, kKeypad1, kKeypadDecimal,
                        0xffaa, 0xffab, 0xffad, 0xffaf, 0xffbd};
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
        check(rime->process_key(session, keys[i], 0),
              "the ascii input mode must consume half-width typing");
        char commit[256];
        check(!take_commit(commit, sizeof(commit)),
              "the ascii input mode must not commit a half-width character");
    }
    check(preedit_equals("Aa1$ 1.*+-/="),
          "the ascii input mode must accumulate the half-width text");
    check(composing(), "the ascii input mode must keep the composition open");

    fresh_session();
    press_shift('A');
    type_text("kannnna");
    check(preedit_equals("Akannnna"),
          "ASCII input must preserve romaji-like text without Japanese substitutions");
}

/* SPEC: Shift+letter switches to the unconfirmed ascii input mode from
 * every Japanese state, restoring the reading first during conversion and
 * appending the half-width uppercase letter to it (dotfiles/rime/SPEC.md). */
static void test_shift_letter_switches_ascii_mode(void) {
    fresh_session();
    press_shift('A');
    check(option("_kagiroi_ascii_input"), "Shift+A while idle must enter the ascii input mode");
    check(preedit_equals("A"), "Shift+A while idle must append A");
    fresh_session();
    type_text("kana");
    press_shift('A');
    check(option("_kagiroi_ascii_input"), "Shift+A while typing must enter the ascii input mode");
    check(preedit_equals("かなA"), "Shift+A while typing must append A to the reading");

    for (int open = 0; open < 2; ++open) {
        fresh_session();
        type_text("kyouhakare-");
        press(kSpace);
        if (open) { press(kSpace); press(kTab); }
        char display[512], expected[1024], commit[1024];
        preview_text(display, sizeof(display));
        snprintf(expected, sizeof(expected), "%sA1", display);
        press_shift('A');
        press('1');
        check(option("_kagiroi_ascii_input") && preedit_equals(expected),
              "Shift+letter must append to the whole converted display");
        check(!option("_kagiroi_off_pending") && !option("_kagiroi_expand_candidates"),
              "Shift+letter must clear reservation and expansion");
        check(!take_commit(commit, sizeof(commit)), "Shift+letter must not commit");
        press(kReturn);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
              "Enter must commit the retained display and additions");
        check(!option("_kagiroi_ascii_input"), "Enter must leave halfwidth input");
    }
}

static void test_romanization_matches_declaration(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        /* base rows: every row of roma.data.yaml, all five columns */
        {"a", "あ"}, {"i", "い"}, {"u", "う"}, {"e", "え"}, {"o", "お"},
        {"la", "ぁ"}, {"li", "ぃ"}, {"lu", "ぅ"}, {"le", "ぇ"}, {"lo", "ぉ"},
        {"ka", "か"}, {"ki", "き"}, {"ku", "く"}, {"ke", "け"}, {"ko", "こ"},
        {"ca", "か"}, {"ci", "き"}, {"cu", "く"}, {"ce", "け"}, {"co", "こ"},
        {"ga", "が"}, {"gi", "ぎ"}, {"gu", "ぐ"}, {"ge", "げ"}, {"go", "ご"},
        {"sa", "さ"}, {"si", "し"}, {"su", "す"}, {"se", "せ"}, {"so", "そ"},
        {"za", "ざ"}, {"zi", "じ"}, {"zu", "ず"}, {"ze", "ぜ"}, {"zo", "ぞ"},
        {"ta", "た"}, {"ti", "ち"}, {"tu", "つ"}, {"te", "て"}, {"to", "と"},
        {"da", "だ"}, {"di", "ぢ"}, {"du", "づ"}, {"de", "で"}, {"do", "ど"},
        {"na", "な"}, {"ni", "に"}, {"nu", "ぬ"}, {"ne", "ね"}, {"no", "の"},
        {"ha", "は"}, {"hi", "ひ"}, {"fu", "ふ"}, {"he", "へ"}, {"ho", "ほ"},
        {"ba", "ば"}, {"bi", "び"}, {"bu", "ぶ"}, {"be", "べ"}, {"bo", "ぼ"},
        {"pa", "ぱ"}, {"pi", "ぴ"}, {"pu", "ぷ"}, {"pe", "ぺ"}, {"po", "ぽ"},
        {"ma", "ま"}, {"mi", "み"}, {"mu", "む"}, {"me", "め"}, {"mo", "も"},
        {"ya", "や"}, {"yu", "ゆ"}, {"ye", "いぇ"}, {"yo", "よ"},
        {"lya", "ゃ"}, {"lyu", "ゅ"}, {"lyo", "ょ"},
        {"ra", "ら"}, {"ri", "り"}, {"ru", "る"}, {"re", "れ"}, {"ro", "ろ"},
        {"wa", "わ"}, {"wi", "うぃ"}, {"we", "うぇ"}, {"wo", "を"},
        {"qa", "くぁ"}, {"qi", "くぃ"}, {"qe", "くぇ"}, {"qo", "くぉ"},
        {"ja", "じゃ"}, {"ji", "じ"}, {"ju", "じゅ"}, {"je", "じぇ"}, {"jo", "じょ"},
        {"fa", "ふぁ"}, {"fi", "ふぃ"}, {"fu", "ふ"}, {"fe", "ふぇ"}, {"fo", "ふぉ"},
        {"va", "ヴぁ"}, {"vi", "ヴぃ"}, {"vu", "ヴ"}, {"ve", "ヴぇ"}, {"vo", "ヴぉ"},
        /* singles */
        {"who", "うぉ"},
        {"wyi", "ゐ"}, {"wye", "ゑ"},
        {"ltu", "っ"}, {"lwa", "ゎ"},
        {"lka", "ヵ"}, {"lke", "ヶ"},
        /* i-column + ya/yu/yo and the ha/hu/ho spellings, every family row
         * except the excluded nh and hh spellings */
        {"kya", "きゃ"}, {"kyu", "きゅ"}, {"kyo", "きょ"},
        {"kha", "きゃ"}, {"khu", "きゅ"}, {"kho", "きょ"},
        {"cya", "きゃ"}, {"cyu", "きゅ"}, {"cyo", "きょ"},
        {"cha", "きゃ"}, {"chu", "きゅ"}, {"cho", "きょ"},
        {"gya", "ぎゃ"}, {"gyu", "ぎゅ"}, {"gyo", "ぎょ"},
        {"gha", "ぎゃ"}, {"ghu", "ぎゅ"}, {"gho", "ぎょ"},
        {"sya", "しゃ"}, {"syu", "しゅ"}, {"syo", "しょ"},
        {"sha", "しゃ"}, {"shu", "しゅ"}, {"sho", "しょ"},
        {"zya", "じゃ"}, {"zyu", "じゅ"}, {"zyo", "じょ"},
        {"zha", "じゃ"}, {"zhu", "じゅ"}, {"zho", "じょ"},
        {"tya", "ちゃ"}, {"tyu", "ちゅ"}, {"tyo", "ちょ"},
        {"tha", "ちゃ"}, {"thu", "ちゅ"}, {"tho", "ちょ"},
        {"dya", "ぢゃ"}, {"dyu", "ぢゅ"}, {"dyo", "ぢょ"},
        {"dha", "ぢゃ"}, {"dho", "ぢょ"},
        {"nya", "にゃ"}, {"nyu", "にゅ"}, {"nyo", "にょ"},
        {"hya", "ひゃ"}, {"hyu", "ひゅ"}, {"hyo", "ひょ"},
        {"bya", "びゃ"}, {"byu", "びゅ"}, {"byo", "びょ"},
        {"bha", "びゃ"}, {"bhu", "びゅ"}, {"bho", "びょ"},
        {"pya", "ぴゃ"}, {"pyu", "ぴゅ"}, {"pyo", "ぴょ"},
        {"pha", "ぴゃ"}, {"phu", "ぴゅ"}, {"pho", "ぴょ"},
        {"mya", "みゃ"}, {"myu", "みゅ"}, {"myo", "みょ"},
        {"rya", "りゃ"}, {"ryu", "りゅ"}, {"ryo", "りょ"},
        {"rha", "りゃ"}, {"rhu", "りゅ"}, {"rho", "りょ"},
        /* e-column + small i, and i-column + small e */
        {"thi", "てぃ"}, {"dhi", "でぃ"},
        {"khe", "きぇ"}, {"che", "きぇ"}, {"ghe", "ぎぇ"}, {"she", "しぇ"},
        {"the", "ちぇ"},
        /* u-column + small a/i/e/o, and o-column + small u families */
        {"kwa", "くぁ"}, {"kwi", "くぃ"}, {"kwe", "くぇ"}, {"kwo", "くぉ"},
        {"cwa", "くぁ"}, {"cwi", "くぃ"}, {"cwe", "くぇ"}, {"cwo", "くぉ"},
        {"gwa", "ぐぁ"}, {"gwi", "ぐぃ"}, {"gwe", "ぐぇ"}, {"gwo", "ぐぉ"},
        {"swa", "すぁ"}, {"swi", "すぃ"}, {"swe", "すぇ"}, {"swo", "すぉ"},
        {"zwa", "ずぁ"}, {"zwi", "ずぃ"}, {"zwe", "ずぇ"}, {"zwo", "ずぉ"},
        {"twa", "つぁ"}, {"twi", "つぃ"}, {"twe", "つぇ"}, {"two", "つぉ"},
        {"dwa", "づぁ"}, {"dwi", "づぃ"}, {"dwe", "づぇ"}, {"dwo", "づぉ"},
        {"hwa", "ふぁ"}, {"hwi", "ふぃ"}, {"hwe", "ふぇ"}, {"hwo", "ふぉ"},
        {"bwa", "ぶぁ"}, {"bwi", "ぶぃ"}, {"bwe", "ぶぇ"}, {"bwo", "ぶぉ"},
        /* Character conditions map m before w to ん, so mwa/mwo read んわ/んを
         * (dotfiles/rime/SPEC.md, "ローマ字表"). */
        {"rwa", "るぁ"}, {"rwi", "るぃ"}, {"rwe", "るぇ"}, {"rwo", "るぉ"},
        {"kwu", "こぅ"}, {"cwu", "こぅ"}, {"gwu", "ごぅ"}, {"swu", "そぅ"},
        {"zwu", "ぞぅ"}, {"twu", "とぅ"}, {"dwu", "どぅ"},
        {"hwu", "ほぅ"}, {"bwu", "ぼぅ"},
        {"rwu", "ろぅ"},
        /* dhu beats the stock yoon spelling (ぢゅ) with the single */
        {"dhu", "でゅ"},
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

/* ---------- static checks of the declaration pipeline ---------- */

static char* read_small_file(const char* path) {
    FILE* file = fopen(path, "rb");
    if (!file) return NULL;
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return NULL;
    }
    long size = ftell(file);
    if (size < 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return NULL;
    }
    char* buffer = malloc((size_t)size + 1);
    if (!buffer) {
        fclose(file);
        return NULL;
    }
    size_t read = fread(buffer, 1, (size_t)size, file);
    fclose(file);
    if (read != (size_t)size) {
        free(buffer);
        return NULL;
    }
    buffer[size] = '\0';
    return buffer;
}

static Bool text_contains(const char* haystack, const char* needle) {
    return strstr(haystack, needle) != NULL;
}

/* Whether the generated dictionary holds a mapping with this code (the
 * second tab-separated field of a mapping line). */
/* The record lines are `kana\tcode\tweight`; the kana lookup mirrors
 * dict_has_code over the text column. */
static Bool code_text_is(const char* dictionary, const char* code, const char* text) {
    const char* line = dictionary;
    while (line && *line) {
        const char* end = strchr(line, '\n');
        size_t length = end ? (size_t)(end - line) : strlen(line);
        const char* first_tab = memchr(line, '\t', length);
        if (first_tab) {
            const char* code_start = first_tab + 1;
            size_t rest = (size_t)(line + length - code_start);
            const char* second_tab = memchr(code_start, '\t', rest);
            if (second_tab && (size_t)(second_tab - code_start) == strlen(code)
                && memcmp(code_start, code, strlen(code)) == 0) {
                return (size_t)(first_tab - line) == strlen(text)
                    && memcmp(line, text, strlen(text)) == 0;
            }
        }
        line = end ? end + 1 : NULL;
    }
    return False;
}

static Bool dict_has_code(const char* dictionary, const char* code) {
    const char* line = dictionary;
    while (line && *line) {
        const char* end = strchr(line, '\n');
        size_t length = end ? (size_t)(end - line) : strlen(line);
        const char* first_tab = memchr(line, '\t', length);
        if (first_tab) {
            const char* code_start = first_tab + 1;
            size_t rest = (size_t)(line + length - code_start);
            const char* second_tab = memchr(code_start, '\t', rest);
            if (second_tab && (size_t)(second_tab - code_start) == strlen(code)
                && memcmp(code_start, code, strlen(code)) == 0) {
                return True;
            }
        }
        line = end ? end + 1 : NULL;
    }
    return False;
}

/* SPEC: the romaji dictionary is generated from the declaration only: the
 * managed patch points the layout schema at it and disables the stock
 * algebra, no stock table is imported, and the hatsuon spellings, empty
 * slots and excluded families of roma.data.yaml generate no entries
 * (dotfiles/rime/SPEC.md, "ローマ字表"). */
static void test_romaji_dictionary_is_declaration_only(void) {
    static const char* const kConsonants[] = {
        "b", "c", "d", "f", "g", "h", "j", "k", "l", "m",
        "p", "q", "r", "s", "t", "v", "w", "x", "z",
    };
    static const char* const kVowels[] = {"a", "i", "u", "e", "o"};
    static const char* const kEmptySlots[] = {"qu", "wu", "yi", "lyi", "lye"};
    static const char* const kExcluded[] = {
        "nha", "nhi", "nhe", "nhu", "nho",
    };
    /* Prefix pairs are records; completed-syllable cross-products are not. */
    static const struct {
        const char* code;
        const char* text;
    } kPrefixes[] = {
        {"hh", "っh"}, {"tt", "っt"}, {"kk", "っk"},
        {"kc", "っc"}, {"ck", "っk"}, {"nt", "んt"}, {"mt", "んt"},
        {"nm", "んm"}, {"mn", "んn"},
    };
    static const char* const kCompletedPrefixes[] = {
        "hha", "hhi", "hhe", "hhu", "hho", "kka", "kkha", "tta", "kca", "cka",
    };

    char path[512];
    snprintf(path, sizeof(path), "%s/kagiroi_dotfiles_romaji.dict.yaml", g_user_data_dir);
    char* dictionary = read_small_file(path);
    check(dictionary != NULL, "the generated romaji dictionary must exist in the workspace");
    if (!dictionary) return;
    check(text_contains(dictionary, "name: kagiroi_dotfiles_romaji"),
          "the generated dictionary must carry the declaration's name");
    check(!text_contains(dictionary, "import_tables"),
          "the generated dictionary must not import any stock table");

    char code[8];
    char description[128];
    for (size_t c = 0; c < sizeof(kConsonants) / sizeof(kConsonants[0]); ++c) {
        for (size_t v = 0; v < sizeof(kVowels) / sizeof(kVowels[0]); ++v) {
            int written = snprintf(code, sizeof(code), "n%s%s", kConsonants[c], kVowels[v]);
            if (written <= 0 || (size_t)written >= sizeof(code)) continue;
            /* nya/nyu/nyo are the legitimate generated spellings of the
             * n row (nwu is not declared: the n row left the o-column+wu
             * family); only the remaining n-plus-consonant codes are
             * hatsuon */
            if (strcmp(code, "nya") == 0 || strcmp(code, "nyu") == 0
                || strcmp(code, "nyo") == 0) {
                continue;
            }
            snprintf(description, sizeof(description),
                     "the dictionary must not hold the hatsuon spelling %s", code);
            check(!dict_has_code(dictionary, code), description);
        }
    }
    for (size_t v = 0; v < sizeof(kVowels) / sizeof(kVowels[0]); ++v) {
        snprintf(code, sizeof(code), "nn%s", kVowels[v]);
        snprintf(description, sizeof(description),
                 "the dictionary must not hold the hatsuon spelling %s", code);
        check(!dict_has_code(dictionary, code), description);
    }
    for (size_t i = 0; i < sizeof(kEmptySlots) / sizeof(kEmptySlots[0]); ++i) {
        snprintf(description, sizeof(description),
                 "the dictionary must not hold the empty-slot spelling %s", kEmptySlots[i]);
        check(!dict_has_code(dictionary, kEmptySlots[i]), description);
    }
    for (size_t i = 0; i < sizeof(kExcluded) / sizeof(kExcluded[0]); ++i) {
        snprintf(description, sizeof(description),
                 "the dictionary must not hold the excluded family spelling %s", kExcluded[i]);
        check(!dict_has_code(dictionary, kExcluded[i]), description);
    }
    for (size_t i = 0; i < sizeof(kPrefixes) / sizeof(kPrefixes[0]); ++i) {
        snprintf(description, sizeof(description),
                 "the dictionary must read prefix %s as %s", kPrefixes[i].code, kPrefixes[i].text);
        check(code_text_is(dictionary, kPrefixes[i].code, kPrefixes[i].text), description);
    }
    for (size_t i = 0; i < sizeof(kCompletedPrefixes) / sizeof(kCompletedPrefixes[0]); ++i) {
        snprintf(description, sizeof(description),
                 "the dictionary must not generate completed prefix %s", kCompletedPrefixes[i]);
        check(!dict_has_code(dictionary, kCompletedPrefixes[i]), description);
    }
    /* The singles mappings for nn/mm take priority over generated mappings
     * (dotfiles/rime/SPEC.md, "ローマ字表"). */
    check(code_text_is(dictionary, "nn", "ん"), "the dictionary must read nn as ん");
    check(code_text_is(dictionary, "mm", "ん"), "the dictionary must read mm as ん");
    free(dictionary);

    snprintf(path, sizeof(path), "%s/kagiroi_romaji.custom.yaml", g_user_data_dir);
    char* patch = read_small_file(path);
    check(patch != NULL, "the managed romaji patch must exist in the workspace");
    if (patch) {
        check(text_contains(patch, "translator/dictionary: kagiroi_dotfiles_romaji"),
              "the managed patch must point the layout at the generated dictionary");
        check(text_contains(patch, "speller/algebra: null"),
              "the managed patch must disable the stock algebra");
        free(patch);
    }

    snprintf(path, sizeof(path), "%s/build/kagiroi_romaji.schema.yaml", g_user_data_dir);
    char* schema = read_small_file(path);
    check(schema != NULL, "the compiled romaji schema must exist in the workspace");
    if (schema) {
        check(!text_contains(schema, "algebra"),
              "the compiled romaji schema must not derive any spellings");
        check(text_contains(schema, "dictionary: kagiroi_dotfiles_romaji"),
              "the compiled romaji schema must use the generated dictionary");
        check(!text_contains(schema, "import_tables"),
              "the compiled romaji schema must not import a stock table");
        free(schema);
    }
}

/* SPEC: strings of ASCII alphanumerics convert without committing and their
 * candidate list holds the original, full-width, half-width and letter-case
 * forms (dotfiles/rime/SPEC.md). */
static void test_ascii_variants_candidates(void) {
    char commit[256];

    /* Half-width letters typed in the ascii input mode, returned to the
     * Japanese input before converting. */
    fresh_session();
    press_shift('A');
    type_text("bc");
    press(kZenkakuHankaku);
    check(!option("_kagiroi_ascii_input"), "the test must return to the Japanese mode");
    press(kSpace);
    check(!take_commit(commit, sizeof(commit)), "the first Space must not commit the letters");
    check(composing(), "the letters must stay unconfirmed through the conversion");
    RIME_STRUCT(RimeContext, context);
    if (current_menu(&context)) {
        check(context.menu.num_candidates == 0,
              "the first Space on the letters must keep the list hidden");
        rime->free_context(&context);
    }
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the second Space must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates >= 3,
          "the letters must expose their character-type candidates");
    check(menu_has_candidate(&context, "Abc")
              && menu_has_candidate(&context, "Ａｂｃ")
              && menu_has_candidate(&context, "ABC")
              && menu_has_candidate(&context, "abc"),
          "the menu must contain the original, full-width and case forms");
    rime->free_context(&context);
    check(!take_commit(commit, sizeof(commit)), "the reveal must not commit");

    /* Main-row digits convert to themselves and offer the half-width form. */
    fresh_session();
    type_text("123");
    press(kSpace);
    check(!take_commit(commit, sizeof(commit)), "the first Space must not commit the digits");
    check(preedit_equals("１２３"), "the digits must convert to themselves");
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the digit menu must keep a queryable context");
        return;
    }
    check(menu_has_candidate(&context, "１２３") && menu_has_candidate(&context, "123"),
          "the digit menu must contain both width forms");
    rime->free_context(&context);
}

/* SPEC: the keypad symbol keys add half-width characters in both input
 * modes. During conversion they commit the whole display and restart with
 * the half-width character; the ordinary symbol keys keep their separate
 * Japanese mappings (dotfiles/rime/SPEC.md, "共通の文字対応"). */
static void test_keypad_symbols_in_conversion_states(void) {
    static const int kKeypadSeparator = 0xffac;
    static const struct { int key; const char* half_width; } symbols[] = {
        {kKeypadDecimal, "."}, {kKeypadSeparator, ","}, {0xffaa, "*"},
        {0xffab, "+"}, {0xffad, "-"}, {0xffaf, "/"}, {0xffbd, "="},
    };
    char commit[256];

    /* From the hidden conversion, each keypad symbol commits the whole
     * display and restarts the input with its half-width character. */
    for (size_t i = 0; i < sizeof(symbols) / sizeof(symbols[0]); ++i) {
        fresh_session();
        type_text("kanji");
        press(kSpace);
        RIME_STRUCT(RimeContext, context);
        char hidden_display[256] = "";
        if (current_menu(&context)) {
            if (context.menu.num_candidates == 0 && context.composition.preedit)
                snprintf(hidden_display, sizeof(hidden_display), "%s",
                         context.composition.preedit);
            rime->free_context(&context);
        } else {
            check(False, "the hidden conversion must keep a queryable context");
        }
        check(hidden_display[0] != '\0',
              "the hidden conversion must expose its display immediately after Space");
        press(symbols[i].key);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, hidden_display) == 0,
              "the keypad symbol in the hidden conversion must commit the whole display");
        check(preedit_equals(symbols[i].half_width) && menu_hidden() && composing(),
              "the keypad symbol in the hidden conversion must restart with its half-width character");
        check(!take_commit(commit, sizeof(commit)),
              "the restart must leave the fresh half-width character uncommitted");
        check(!option("_kagiroi_expand_candidates"),
              "the keypad symbol must release candidate expansion");
    }

    /* While typing, the keypad symbols stay half-width while the ordinary
     * symbol keys keep their Japanese mappings. */
    static const struct {
        int keypad;
        const char* keypad_after;
        int ordinary;
        const char* ordinary_after;
    } contrast[] = {
        {0xffad, "かな-", '-', "かなー"},
        {0xffaf, "かな/", '/', "かな・"},
        {kKeypadDecimal, "かな.", '.', "かな。"},
        {kKeypadSeparator, "かな,", ',', "かな、"},
    };
    for (size_t i = 0; i < sizeof(contrast) / sizeof(contrast[0]); ++i) {
        fresh_session();
        type_text("kana");
        press(contrast[i].keypad);
        check(preedit_equals(contrast[i].keypad_after),
              "the keypad symbol must append its half-width character while typing");
        fresh_session();
        type_text("kana");
        press(contrast[i].ordinary);
        check(preedit_equals(contrast[i].ordinary_after),
              "the ordinary symbol key must keep its Japanese mapping");
    }

    /* Inside the ascii input mode the keypad symbols stay half-width. */
    fresh_session();
    press_shift('A');
    for (size_t i = 0; i < sizeof(symbols) / sizeof(symbols[0]); ++i) {
        press(symbols[i].key);
    }
    check(preedit_equals("A.,*+-/="),
          "the keypad symbols in the mode must append half-width characters");
    check(!take_commit(commit, sizeof(commit)),
          "the keypad symbols in the mode must not commit");
}

/* SPEC: Left and Right move the caret while typing and select the conversion
 * blocks during conversion and with the menu open; Shift+Left/Shift+Right
 * make the selected conversion segment shorter or longer
 * (dotfiles/rime/SPEC.md). */
static void test_arrow_caret_and_segments(void) {
    RIME_STRUCT(RimeContext, context);

    /* While typing the caret moves away from the end and back. */
    fresh_session();
    type_text("kanjimoji");
    if (!current_menu(&context)) {
        check(False, "the typing state must keep a queryable context");
        return;
    }
    size_t end_caret = context.composition.cursor_pos;
    check(end_caret > 0, "the caret must start at the end of the reading");
    press(kLeft);
    if (!current_menu(&context)) {
        check(False, "Left while typing must keep a queryable context");
        return;
    }
    check(context.composition.cursor_pos < end_caret,
          "Left while typing must move the caret leftwards");
    press(kRight);
    if (!current_menu(&context)) {
        check(False, "Right while typing must keep a queryable context");
        return;
    }
    check(context.composition.cursor_pos == end_caret,
          "Right while typing must move the caret back to the end");
    rime->free_context(&context);


}

/* SPEC: Esc with the candidate list visible closes the list and keeps the
 * conversion; the next Esc restores the reading
 * (dotfiles/rime/SPEC.md). */
static void test_menu_esc_keeps_conversion(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    char selected[256] = "";
    if (current_menu(&context)) {
        int index = context.menu.highlighted_candidate_index;
        if (index < context.menu.num_candidates && context.menu.candidates[index].text)
            snprintf(selected, sizeof(selected), "%s", context.menu.candidates[index].text);
        rime->free_context(&context);
    }
    check(selected[0] != '\0', "the menu must hold a selection before Esc");
    press(kEscape);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "Esc with the menu open must not commit");
    check(composing(), "Esc with the menu open must keep the composition");
    if (!current_menu(&context)) {
        check(False, "Esc with the menu open must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates == 0,
          "Esc with the menu open must close the candidate list");
    check(!option("_kagiroi_expand_candidates"),
          "Esc with the menu open must release the expansion");
    rime->free_context(&context);
    check(preedit_equals(selected),
          "Esc with the menu open must keep the conversion to the selected candidate");
    press(kEscape);
    check(preedit_equals("かんじ"),
          "the second Esc must restore the hiragana reading");
    check(composing(), "the second Esc must keep the composition open");
}

/* SPEC: deletion obeys the independent OFF reservation; Enter clears it. */
static void test_ascii_off_reservation_exits(void) {
    /* Toggle origin: Backspace down to empty switches IME OFF. */
    fresh_session();
    type_text("kana");
    press(kZenkakuHankaku);
    check(option("_kagiroi_ascii_input"), "the toggle entry must start in the mode");
    press(kBackSpace);
    press(kBackSpace);
    press(kBackSpace);
    check(!option("_kagiroi_ascii_input"),
          "the emptied toggle-origin string must leave the mode");
    check(option("ascii_mode"),
          "the emptied toggle-origin string must switch IME OFF");
    check(!composing(), "IME OFF must leave nothing unconfirmed");
    rime->set_option(session, "ascii_mode", 0);

    /* Shift origin: Backspace down to empty returns to the Japanese input. */
    fresh_session();
    press_shift('A');
    check(option("_kagiroi_ascii_input"), "the shift entry must start in the mode");
    press(kBackSpace);
    check(!option("_kagiroi_ascii_input"),
          "the emptied shift-origin string must leave the mode");
    check(!option("ascii_mode"),
          "the emptied shift-origin string must return to the Japanese input");

    /* Enter commits and returns to the Japanese input from the toggle
     * origin as well. */
    fresh_session();
    type_text("kana");
    press(kZenkakuHankaku);
    type_text("ab");
    press(kReturn);
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "かなab") == 0,
          "Enter from the mode must commit the whole unconfirmed string");
    check(!option("_kagiroi_ascii_input"), "Enter must leave the mode");
    check(!option("ascii_mode"), "Enter must return to the Japanese input");
}

/* SPEC: ascii_punct is disabled at the start of every session
 * (dotfiles/rime/SPEC.md). */
static void test_ascii_punct_disabled_at_session_start(void) {
    fresh_session();
    check(!option("ascii_punct"),
          "a fresh session must start with ascii_punct disabled");
    rime->set_option(session, "ascii_punct", 1);
    fresh_session();
    check(!option("ascii_punct"),
          "the next fresh session must also start with ascii_punct disabled");
}

/* SPEC: the emoji candidate feature is off by default; a session without a
 * saved setting starts with the option off (dotfiles/rime/SPEC.md,
 * "変換候補と学習"). */
static void test_emoji_option_defaults_off(void) {
    fresh_session();
    check(!option("emoji"),
          "a fresh session without a saved setting must start with the emoji option off");
}

/*
 * SPEC: nn/mm pairs become ん on the second keypress. Space/Henkan resolve
 * only trailing pending n/m, and Enter commits the displayed reading.
 */
static void test_nn_pair_consumption(void) {
    char commit[256];
    fresh_session();
    type_text("n");
    check(preedit_equals("n"), "a lone n must stay pending while typing");
    type_text("n");
    check(preedit_equals("ん"), "nn must read ん on the second keypress");
    fresh_session();
    type_text("m");
    check(preedit_equals("m"), "a lone m must stay pending while typing");
    type_text("m");
    check(preedit_equals("ん"), "mm must read ん on the second keypress");
    fresh_session();
    type_text("nn");
    press(kSpace);
    check(preedit_equals("ん"), "nn + Space must keep reading ん");
    fresh_session();
    type_text("nn");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "ん") == 0,
          "nn + Enter must commit ん");
    fresh_session();
    type_text("mm");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "ん") == 0,
          "mm + Enter must commit ん");
    fresh_session();
    type_text("honn");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "ほん") == 0,
          "honn + Enter must commit ほん");
    /* The consumed pair does not add n to the next vowel or y. */
    fresh_session();
    type_text("kann");
    check(preedit_equals("かん"), "kann must read かん while typing");
    type_text("a");
    check(preedit_equals("かんあ"), "kanna must keep the consumed pair separate from あ");
    fresh_session();
    type_text("minna");
    check(preedit_equals("みんあ"), "minna must read みんあ");
    fresh_session();
    type_text("nnyo");
    check(preedit_equals("んよ"), "nnyo must read んよ");
    /* The input-time literal substitution runs before any conversion. */
    fresh_session();
    type_text("kannnna");
    check(preedit_equals("かんな"), "kannnna must read かんな while typing");
    /* a lone pending n keeps the pending display; the first Space resolves
     * it into the inline conversion and Esc restores the corrected reading
     * (dotfiles/rime/SPEC.md) */
    fresh_session();
    type_text("kan");
    check(preedit_equals("かn"), "kan must keep the pending かn display");
    press(kSpace);
    press(kEscape);
    check(preedit_equals("かん"), "kan + Space then Esc must restore かん");
}

/*
 * SPEC: the longest declared suffix converts while an undeclared prefix stays
 * raw; stock Kagiroi and speller/algebra spellings are not imported.
 */
static void test_longest_declared_suffix_preserves_raw_prefix(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"fdsa", "fdさ"}, {"shi", "sひ"}, {"fdsha", "fdしゃ"},
        {"fdnn", "fdん"}, {"fdnka", "fdんか"},
        {"chi", "cひ"}, {"tsu", "tす"}, {"ltsu", "ltす"},
        {"kyi", "kyい"}, {"kye", "kいぇ"}, {"wha", "wは"},
        {"tsa", "tさ"}, {"dhe", "dへ"}, {"fya", "fや"},
        /* empty slots of roma.data.yaml fall back to the longest declared
         * suffix instead of a mapping of their own
         * (dotfiles/rime/SPEC.md, "ローマ字表") */
        {"qu", "qう"}, {"wu", "wう"}, {"yi", "yい"},
        {"lyi", "lyい"}, {"lye", "lいぇ"},
        /* nwu is not declared (the n row left the o-column+wu family)
         * but typing still forms it: w completes the pending n, and the
         * empty-slot wu then leaves w raw before u */
        {"nwu", "んwう"},
        /* pw* is not declared either (the p row left the u/o-column w
         * families): wa/wi/we/wo still complete through the declared w
         * row, while the empty-slot wu leaves pw raw before u */
        {"pwa", "pわ"}, {"pwi", "pうぃ"}, {"pwe", "pうぇ"},
        {"pwo", "pを"}, {"pwu", "pwう"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        char description[128];
        snprintf(description, sizeof(description),
                 "%s must preserve its raw prefix and convert the longest suffix to %s",
                 cases[i].input, cases[i].expected);
        check(preedit_equals(cases[i].expected), description);
    }
}

/*
 * SPEC: character conditions replace the first letter of doubled consonants
 * with っ, and replace n/m before another consonant with ん. The long vowel
 * binds to the - key, and the stock q binding is gone.
 */
static void test_sokuon_hatsuon_and_long_vowel(void) {
    /* Completed doubled-consonant spellings retain their expected readings. */
    static const struct {
        const char* input;
        const char* expected;
    } sokuon[] = {
        {"kka", "っか"}, {"cca", "っか"}, {"kca", "っか"}, {"cka", "っか"},
        {"gga", "っが"}, {"hha", "っは"},
        {"jja", "っじゃ"}, {"tta", "った"}, {"ffa", "っふぁ"}, {"wwa", "っわ"},
        {"rra", "っら"}, {"zza", "っざ"}, {"ssa", "っさ"}, {"vva", "っヴぁ"},
        {"lla", "っぁ"}, {"dda", "っだ"}, {"bba", "っば"}, {"ppa", "っぱ"},
        {"yya", "っや"}, {"qqa", "っくぁ"},
        /* family spellings and other vowels behind the doubled consonant */
        {"tte", "って"}, {"ssha", "っしゃ"}, {"ttya", "っちゃ"},
        {"kkha", "っきゃ"},
        {"kkka", "っっか"},
        {"tt", "っt"}, {"kk", "っk"}, {"kc", "っc"}, {"ck", "っk"},
    };
    for (size_t i = 0; i < sizeof(sokuon) / sizeof(sokuon[0]); ++i) {
        fresh_session();
        type_text(sokuon[i].input);
        char description[128];
        snprintf(description, sizeof(description),
                 "%s must read %s while composing", sokuon[i].input, sokuon[i].expected);
        check(preedit_equals(sokuon[i].expected), description);
    }
    fresh_session();
    type_text("kkanji");
    check(preedit_equals("っかんじ"),
          "kkanji must read っかんじ while composing");
    /* Prefixes show their eager replacement before the syllable completes. */
    fresh_session();
    type_text("tt");
    check(preedit_equals("っt"), "tt must eagerly read っt");
    press('a');
    check(preedit_equals("った"), "tta must complete into the sokuon reading");
    fresh_session();
    type_text("kk");
    check(preedit_equals("っk"), "kk must eagerly read っk");
    press('a');
    check(preedit_equals("っか"), "kka must complete into the sokuon reading");
    fresh_session();
    type_text("kkka");
    check(preedit_equals("っっか"), "kkka must read っっか");
    static const struct {
        const char* input;
        const char* expected;
    } hatsuon[] = {
        {"nka", "んか"}, {"nta", "んた"}, {"nja", "んじゃ"}, {"nha", "んは"},
        {"mka", "んか"}, {"mta", "んた"}, {"mk", "んk"}, {"mma", "んあ"},
        {"samba", "さんば"}, {"samma", "さんあ"}, {"mann", "まん"},
    };
    for (size_t i = 0; i < sizeof(hatsuon) / sizeof(hatsuon[0]); ++i) {
        fresh_session();
        type_text(hatsuon[i].input);
        char description[128];
        snprintf(description, sizeof(description),
                 "%s must read %s while composing", hatsuon[i].input, hatsuon[i].expected);
        check(preedit_equals(hatsuon[i].expected), description);
    }
    /* The final んんあ substitution is visible as soon as it is typed. */
    fresh_session();
    type_text("sammmma");
    check(preedit_equals("さんな"), "sammmma must read さんな while typing");
    press(kSpace);
    check(preedit_equals("さんな"), "Space must preserve sammmma's input-time reading");
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
 * SPEC: the first Space converts to the first candidate with the list
 * hidden, the second Space reveals the list with the second candidate
 * selected, and Esc returns to the reading (dotfiles/rime/SPEC.md).
 */
static void test_first_space_converts_to_first_candidate(void) {
    fresh_session();
    type_text("kanji");
    if (g_verbose) {
        printf("  after typing:\n");
        print_context();
    }
    press(kSpace);
    check(composing(), "first Space must keep the composition open");
    RIME_STRUCT(RimeContext, context);
    check(current_menu(&context) && context.menu.num_candidates == 0,
          "first Space must keep the candidate list hidden");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "first Space must not commit");

    press(kSpace);
    char first[256] = "";
    if (!rime->get_context(session, &context)) {
        check(False, "second Space must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates > 0, "second Space must reveal the menu");
    check(context.menu.highlighted_candidate_index == 1,
          "second Space must select the second candidate");
    char selected[256] = "";
    if (context.menu.num_candidates > 1 && context.menu.candidates[0].text) {
        snprintf(first, sizeof(first), "%s", context.menu.candidates[0].text);
    }
    if (context.menu.num_candidates > context.menu.highlighted_candidate_index
        && context.menu.candidates[context.menu.highlighted_candidate_index].text) {
        snprintf(selected, sizeof(selected), "%s",
                 context.menu.candidates[context.menu.highlighted_candidate_index].text);
    }
    rime->free_context(&context);
    check(first[0] != '\0', "the menu must hold a first candidate");
    check(selected[0] != '\0', "the menu must hold the selected candidate");

    press(kEscape);
    check(preedit_equals(selected),
          "Esc after the reveal must keep the conversion to the selected candidate");
    press(kEscape);
    check(preedit_equals("かんじ"),
          "the second Esc must return to the hiragana reading");
    press(kSpace);
    check(preedit_equals(first),
          "the first Space must show the first candidate inline");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, first) == 0,
          "Enter must commit the first candidate shown inline");
    check(!composing(), "the commit must end the composition");
}

/* SPEC: after the reveal, later Spaces move the selection over the whole
 * candidate set across pages and wrap past the final candidate; the
 * collapsed window follows the selection and numbers its Page comment from
 * the final display order (dotfiles/rime/SPEC.md, "候補選択の循環"). */
static void test_space_cycles_candidates(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "candidate menu must exist before cycling");
        return;
    }
    check(context.menu.highlighted_candidate_index == 1,
          "the reveal must highlight the second candidate");
    char first_head[256] = "";
    if (context.menu.num_candidates > 0 && context.menu.candidates[0].text)
        snprintf(first_head, sizeof(first_head), "%s", context.menu.candidates[0].text);
    rime->free_context(&context);
    check(first_head[0] != '\0', "the menu must hold a first candidate");

    /* Nine more Spaces cross the collapsed window: the eleventh candidate
     * becomes the window head and the Page comment follows the final order. */
    for (int i = 0; i < 9; ++i) press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the menu must survive crossing the collapsed page");
        return;
    }
    check(context.menu.highlighted_candidate_index == 0,
          "crossing the collapsed page must highlight the window head");
    check(context.menu.candidates[0].comment &&
              strstr(context.menu.candidates[0].comment, "Page 2"),
          "the crossed window head must show the final-order Page 2 comment");
    char crossed_head[256] = "";
    if (context.menu.num_candidates > 0 && context.menu.candidates[0].text)
        snprintf(crossed_head, sizeof(crossed_head), "%s", context.menu.candidates[0].text);
    rime->free_context(&context);
    check(crossed_head[0] != '\0' && strcmp(crossed_head, first_head) != 0,
          "the crossed window must show later candidates, not the first window");

    /* Expand and collect the complete final order; the current selection
     * must be its eleventh candidate. */
    press(kTab);
    char choices[512][256];
    int total = 0;
    RimeCandidateListIterator iterator = {0};
    if (!rime->candidate_list_begin(session, &iterator)) {
        check(False, "the complete candidate iterator must be available");
        return;
    }
    while (total < 512 && rime->candidate_list_next(&iterator)) {
        snprintf(choices[total++], sizeof(choices[0]), "%s", iterator.candidate.text);
    }
    rime->candidate_list_end(&iterator);
    check(total > 10, "kanji must hold more candidates than one collapsed window");
    if (total <= 10) return;
    check(strcmp(choices[0], first_head) == 0,
          "the collected final order must start with the initial window head");
    check(strcmp(choices[10], crossed_head) == 0,
          "Space cycling must follow the final display order across the window");
    if (!current_menu(&context)) {
        check(False, "the expanded menu must stay readable");
        return;
    }
    check(context.menu.highlighted_candidate_index == 10,
          "expansion must keep the eleventh candidate selected");
    rime->free_context(&context);

    /* Cycling by text over the whole set proves the movement covers every
     * candidate, not just the visible window modulo. */
    int index = 10;
    for (int presses = 1; presses < total; ++presses) {
        press(kSpace);
        RIME_STRUCT(RimeContext, cycle);
        if (!current_menu(&cycle)) {
            check(False, "the menu must survive cycling");
            return;
        }
        index = (index + 1) % total;
        const char* text = cycle.menu.candidates[cycle.menu.highlighted_candidate_index].text;
        check(text && strcmp(text, choices[index]) == 0,
              "Space must advance through every final candidate and wrap to the first");
        rime->free_context(&cycle);
    }
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "cycling must not commit");
}

/* SPEC: arrows wrap within ten before Tab; after expansion they navigate
 * across all pages. The reading ka has more than 30 candidates. */
static void test_arrow_navigation_across_pages(void) {
    fresh_session();
    type_text("ka");
    press(kSpace);
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "ka must expose a candidate menu");
        return;
    }
    check(context.menu.num_candidates == 10 && context.menu.is_last_page,
          "ka must initially expose only ten candidates");
    rime->free_context(&context);

    press(kUp);
    press(kUp);
    if (!current_menu(&context)) {
        check(False, "Up must preserve the collapsed candidate menu");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 9,
          "Up before expansion must wrap to the tenth candidate");
    rime->free_context(&context);
    press(kDown);
    if (!current_menu(&context)) {
        check(False, "Down must preserve the collapsed candidate menu");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 0,
          "Down before expansion must wrap to the first candidate");
    rime->free_context(&context);
    press(kTab);
    if (!current_menu(&context)) {
        check(False, "Tab must preserve the candidate menu");
        return;
    }
    check(context.menu.num_candidates == 30 && !context.menu.is_last_page &&
              context.menu.highlighted_candidate_index == 0,
          "Tab must expand to thirty without changing the arrow selection");
    rime->free_context(&context);
    press(kUp);
    if (!current_menu(&context)) {
        check(False, "Up must preserve the expanded candidate menu");
        return;
    }
    check(context.menu.page_no >= 1 && context.menu.is_last_page &&
              context.menu.highlighted_candidate_index == context.menu.num_candidates - 1,
          "Up after expansion must wrap to the last candidate");
    rime->free_context(&context);
    press(kDown);
    if (!current_menu(&context)) {
        check(False, "Down must preserve the candidate menu");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 0,
          "Down from the last candidate must wrap to the first");
    rime->free_context(&context);
    for (int i = 0; i < 30; ++i) press(kDown);
    if (!current_menu(&context)) {
        check(False, "Down must preserve the menu across pages");
        return;
    }
    check(context.menu.page_no == 1 && context.menu.highlighted_candidate_index == 0,
          "Down must cross from candidate 30 to candidate 31");
    rime->free_context(&context);
    press(kUp);
    if (!current_menu(&context)) {
        check(False, "Up must preserve the menu across pages");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 29,
          "Up must cross from candidate 31 to candidate 30");
    rime->free_context(&context);
    press(kPageDown);
    if (!current_menu(&context)) {
        check(False, "PageDown must preserve the candidate menu");
        return;
    }
    check(context.menu.page_no == 1 && context.menu.highlighted_candidate_index == 0,
          "PageDown must select the second page's first candidate");
    rime->free_context(&context);
    press(kPageUp);
    if (!current_menu(&context)) {
        check(False, "PageUp must preserve the candidate menu");
        return;
    }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 0,
          "PageUp must select the first page's first candidate");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)) && composing(),
          "candidate navigation must leave the composition uncommitted");
}

/* SPEC: the listed editing, mode and emoji shortcuts are unassigned in Rime
 * in every IME ON state: the key events are not consumed, pass through to
 * the application, and preserve the whole state
 * (dotfiles/rime/SPEC.md, "ショートカット"). */
static void test_listed_shortcuts_pass_through(void) {
    static const struct { int key; int modifier; const char* name; } shortcuts[] = {
        {'p', 4, "Control+p"}, {'n', 4, "Control+n"}, {'b', 4, "Control+b"},
        {'f', 4, "Control+f"}, {'a', 4, "Control+a"}, {'e', 4, "Control+e"},
        {'d', 4, "Control+d"}, {'k', 4, "Control+k"}, {'h', 4, "Control+h"},
        {'g', 4, "Control+g"}, {0x5b, 4, "Control+bracketleft"},
        {'1', 5, "Control+Shift+1"}, {'2', 5, "Control+Shift+2"},
        {'3', 5, "Control+Shift+3"}, {'4', 5, "Control+Shift+4"},
        {'5', 5, "Control+Shift+5"},
        {'!', 5, "Control+Shift+exclam"}, {'@', 5, "Control+Shift+at"},
        {'#', 5, "Control+Shift+numbersign"}, {'$', 5, "Control+Shift+dollar"},
        {'%', 5, "Control+Shift+percent"},
        {'q', 4, "Control+q"},
    };
    for (int state = 0; state < 5; ++state) {
        for (size_t i = 0; i < sizeof(shortcuts) / sizeof(shortcuts[0]); ++i) {
            fresh_session();
            /* idle, typing, hidden conversion, candidate list, halfwidth */
            if (state >= 1) type_text("kyou");
            if (state >= 2) press(kSpace);
            if (state >= 3) press(kSpace);
            if (state == 4) press(kMuhenkan);
            Bool ascii_mode = option("ascii_mode");
            Bool ascii_input = option("_kagiroi_ascii_input");
            Bool pending = option("_kagiroi_off_pending");
            Bool expanded = option("_kagiroi_expand_candidates");
            Bool composing_before = composing();
            RIME_STRUCT(RimeContext, before);
            check(current_menu(&before), "the shortcut regression must start with a readable context");
            char before_preedit[512] = "";
            snprintf(before_preedit, sizeof(before_preedit), "%s",
                     before.composition.preedit ? before.composition.preedit : "");
            char before_preview[512] = "";
            snprintf(before_preview, sizeof(before_preview), "%s",
                     before.commit_text_preview ? before.commit_text_preview : "");
            int before_candidates = before.menu.num_candidates;
            int before_page = before.menu.page_no;
            int before_highlight = before.menu.highlighted_candidate_index;
            rime->free_context(&before);
            Bool consumed = rime->process_key(session, shortcuts[i].key, shortcuts[i].modifier);
            char description[160];
            snprintf(description, sizeof(description),
                     "%s in state %d must pass through unconsumed", shortcuts[i].name, state);
            check(consumed == False, description);
            check(option("ascii_mode") == ascii_mode &&
                      option("_kagiroi_ascii_input") == ascii_input &&
                      option("_kagiroi_off_pending") == pending &&
                      option("_kagiroi_expand_candidates") == expanded &&
                      option("emoji") == False,
                  "a listed shortcut must preserve every mode option");
            check(composing() == composing_before,
                  "a listed shortcut must preserve the composition state");
            RIME_STRUCT(RimeContext, after);
            check(current_menu(&after), "the shortcut regression must keep a readable context");
            check(strcmp(after.composition.preedit ? after.composition.preedit : "", before_preedit) == 0 &&
                      strcmp(after.commit_text_preview ? after.commit_text_preview : "", before_preview) == 0 &&
                      after.menu.num_candidates == before_candidates &&
                      after.menu.page_no == before_page &&
                      after.menu.highlighted_candidate_index == before_highlight,
                  "a listed shortcut must preserve text, list, page and selection");
            rime->free_context(&after);
            char commit[512];
            check(!take_commit(commit, sizeof(commit)), "a listed shortcut must never commit");
        }
    }

    /* The unlisted stock Control+u/i/o switches stay bound through the
     * schema patch; only the listed Control+q was removed. */
    fresh_session();
    type_text("kyou");
    check(rime->process_key(session, 'u', 4),
          "the unlisted Control+u switch must remain bound by the stock schema");
    check(option("hiragana"), "Control+u must still set the hiragana option");
}

/* SPEC: legacy control/alt shortcuts must not page the candidate menu. */
static void test_modifier_shortcuts_do_not_page(void) {
    static const struct { int key; int modifier; } keys[] = {
        {'y', 4}, {'v', 8}, {'v', 4},
    };
    fresh_session();
    type_text("ka");
    press(kSpace);
    press(kSpace);
    press(kTab);
    press(kPageDown);
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
        RIME_STRUCT(RimeContext, before);
        if (!current_menu(&before)) {
            check(False, "the modifier regression must have a visible menu");
            return;
        }
        int page = before.menu.page_no;
        int highlighted = before.menu.highlighted_candidate_index;
        check(page == 1, "the modifier regression must start on the second page");
        rime->free_context(&before);
        press_modifier(keys[i].key, keys[i].modifier);
        RIME_STRUCT(RimeContext, after);
        if (!current_menu(&after)) {
            check(False, "the modifier shortcut must preserve the menu");
            return;
        }
        check(after.menu.page_no == page && after.menu.highlighted_candidate_index == highlighted,
              "Control+y, Alt+v and Control+v must not page candidates");
        rime->free_context(&after);
    }
}

/* SPEC: - and = on a second page commit the whole displayed selection and
 * restart the input without paging. */
static void test_minus_equal_on_second_page(void) {
    static const struct { int key; const char* symbol; } cases[] = {
        {'-', "ー"}, {'=', "＝"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text("ka");
        press(kSpace);
        press(kSpace);
        press(kTab);
        press(kPageDown);
        RIME_STRUCT(RimeContext, context);
        char selected[256] = "";
        if (current_menu(&context)) {
            check(context.menu.page_no == 1 && context.menu.num_candidates > 0,
                  "the symbol regression must start on a populated second page");
            int index = context.menu.highlighted_candidate_index;
            if (index < context.menu.num_candidates && context.menu.candidates[index].text)
                snprintf(selected, sizeof(selected), "%s", context.menu.candidates[index].text);
            rime->free_context(&context);
        } else {
            check(False, "the second page must expose a menu");
        }
        check(selected[0] != '\0', "the second page must contain a selected candidate");
        press(cases[i].key);
        char commit[256];
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
              "minus/equal on page two must commit the whole displayed selection");
        check(preedit_equals(cases[i].symbol) && menu_hidden(),
              "minus/equal on page two must restart the input with its character");
        check(composing(), "minus/equal on page two must keep composing");
        check(!option("_kagiroi_expand_candidates"),
              "minus/equal on page two must release expansion");
    }
}

static void test_enter_commits_highlighted_candidate(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
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

/* SPEC: committing a lower-ranked candidate records it in the user dictionary
 * and promotes it in the menu for the same reading. Every round commits the
 * same fixed word, each round's selection and rank are observed, and the
 * promotion survives into a new session. */
static void test_learning_promotes_committed_candidate(void) {
    RIME_STRUCT(RimeContext, context);
    char baseline_first[128] = "";
    char target[128] = "";

    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kSpace);
    if (current_menu(&context) && context.menu.num_candidates > 2
        && context.menu.candidates[0].text && context.menu.candidates[1].text) {
        snprintf(baseline_first, sizeof(baseline_first), "%s", context.menu.candidates[0].text);
        snprintf(target, sizeof(target), "%s", context.menu.candidates[1].text);
        rime->free_context(&context);
    } else {
        rime->free_context(&context);
        check(False, "the menu must exist and hold more than two candidates before learning");
        return;
    }

    /* Commit the fixed second-ranked word every round, however its rank
     * shifts, and observe each round's selection, commit and rank. */
    char commit[256];
    int previous_rank = 2;
    for (int round = 0; round < 5; ++round) {
        fresh_session();
        type_text("kanji");
        press(kSpace);
        press(kSpace);
        if (!current_menu(&context)) {
            check(False, "the menu must exist during every learning round");
            return;
        }
        int found = -1;
        for (int i = 0; i < context.menu.num_candidates; ++i) {
            const char* text = context.menu.candidates[i].text;
            if (text && strcmp(text, target) == 0) found = i;
        }
        rime->free_context(&context);
        char description[160];
        snprintf(description, sizeof(description),
                 "learning round %d must keep the fixed word within the visible window", round);
        check(found >= 0, description);
        if (found < 0) return;
        snprintf(description, sizeof(description),
                 "learning round %d must not demote the fixed word", round);
        check(found + 1 <= previous_rank, description);
        previous_rank = found + 1;
        int steps = (found - 1 + 10) % 10;
        for (int i = 0; i < steps; ++i) press(kDown);
        selected_text(commit, sizeof(commit));
        snprintf(description, sizeof(description),
                 "learning round %d must select the fixed word before committing", round);
        check(strcmp(commit, target) == 0, description);
        press(kReturn);
        snprintf(description, sizeof(description),
                 "learning round %d must commit the fixed word", round);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, target) == 0,
              description);
    }

    /* A fresh session keeps the learned promotion for the same reading. */
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kSpace);
    char after_first[128] = "";
    if (current_menu(&context) && context.menu.num_candidates > 0
        && context.menu.candidates[0].text) {
        snprintf(after_first, sizeof(after_first), "%s", context.menu.candidates[0].text);
        rime->free_context(&context);
    } else {
        rime->free_context(&context);
        check(False, "the menu must exist after learning");
        return;
    }
    check(strcmp(after_first, target) == 0,
          "the learned word must lead the same reading in a new session");
    check(strcmp(baseline_first, target) != 0,
          "the learned word must not have been the baseline first candidate");
}

static void preview_text(char* buffer, size_t size) {
    RIME_STRUCT(RimeContext, context);
    buffer[0] = '\0';
    if (current_menu(&context)) {
        if (context.commit_text_preview)
            snprintf(buffer, size, "%s", context.commit_text_preview);
        rime->free_context(&context);
    }
}

static Bool preview_equals(const char* expected) {
    char actual[1024];
    preview_text(actual, sizeof(actual));
    if (strcmp(actual, expected) != 0)
        fprintf(stderr, "      preview expected '%s', got '%s'\n", expected, actual);
    return strcmp(actual, expected) == 0;
}

static void selected_text(char* buffer, size_t size) {
    RIME_STRUCT(RimeContext, context);
    buffer[0] = '\0';
    if (current_menu(&context)) {
        int index = context.menu.highlighted_candidate_index;
        if (index >= 0 && index < context.menu.num_candidates)
            snprintf(buffer, size, "%s", context.menu.candidates[index].text);
        rime->free_context(&context);
    }
}

static Bool active_reading_equals(const char* expected) {
    RIME_STRUCT(RimeContext, context);
    Bool equal = False;
    if (current_menu(&context)) {
        const char* preedit = context.composition.preedit;
        int start = context.composition.sel_start;
        int end = context.composition.sel_end;
        equal = preedit && end >= start && (size_t)(end - start) == strlen(expected)
            && strncmp(preedit + start, expected, end - start) == 0;
        if (!equal)
            fprintf(stderr, "      active reading expected '%s', preedit '%s' [%d,%d]\n",
                    expected, preedit ? preedit : "", start, end);
        rime->free_context(&context);
    }
    return equal;
}

static Bool menu_hidden(void) {
    RIME_STRUCT(RimeContext, context);
    Bool hidden = True;
    if (current_menu(&context)) {
        hidden = context.menu.num_candidates == 0;
        rime->free_context(&context);
    }
    return hidden;
}

static void test_retained_list_transitions(void) {
    const int toggles[] = {kMuhenkan, kZenkakuHankaku};
    const int keys[] = {kUp, kDown, kSpace, 'b', kBackSpace, kEscape, kReturn, kZenkakuHankaku};
    for (int expanded = 0; expanded < 2; ++expanded) {
        for (size_t t = 0; t < sizeof(toggles) / sizeof(toggles[0]); ++t) {
            for (size_t k = 0; k < sizeof(keys) / sizeof(keys[0]); ++k) {
                fresh_session();
                type_text("kyouhakare-");
                press(kSpace);
                press(kSpace);
                if (expanded) press(kTab);
                char display[512], expected[1024], neighbor[512], commit[1024];
                preview_text(display, sizeof(display));
                RIME_STRUCT(RimeContext, before);
                check(current_menu(&before) && before.menu.num_candidates > 1,
                      "retained-list setup must have multiple candidates");
                if (keys[k] == kUp || keys[k] == kDown) {
                    press(keys[k]);
                    preview_text(neighbor, sizeof(neighbor));
                    press(keys[k] == kUp ? kDown : kUp);
                    check(preview_equals(display), "inverse arrow must restore the setup selection");
                }
                press(toggles[t]);
                check(option("_kagiroi_ascii_input") && option("_kagiroi_off_pending"),
                      "toggle must enter halfwidth input with an OFF reservation");
                check(preview_equals(display), "toggle must preserve the full converted display");
                check(!menu_hidden() && option("_kagiroi_expand_candidates") == expanded,
                      "toggle must preserve the list and expansion");
                RIME_STRUCT(RimeContext, retained);
                check(current_menu(&retained) && retained.menu.page_no == before.menu.page_no &&
                      retained.menu.highlighted_candidate_index == before.menu.highlighted_candidate_index &&
                      retained.menu.num_candidates == before.menu.num_candidates,
                      "toggle must retain the visible page and selection");
                rime->free_context(&before);
                rime->free_context(&retained);
                press(keys[k]);
                if (keys[k] == kUp || keys[k] == kDown) {
                    check(!option("_kagiroi_ascii_input") && !option("_kagiroi_off_pending"),
                          "retained-list arrows must restore Japanese and clear the reservation");
                    check(preview_equals(neighbor) && !menu_hidden(),
                          "retained-list arrows must select exactly as Japanese-list arrows");
                    check(option("_kagiroi_expand_candidates") == expanded,
                          "retained-list arrows must preserve expansion");
                } else {
                    check(menu_hidden() && !option("_kagiroi_expand_candidates"),
                          "retained-list edits and Japanese return must close and collapse the list");
                    if (keys[k] == kSpace || keys[k] == 'b') {
                        snprintf(expected, sizeof(expected), "%s%c", display, keys[k]);
                        check(preedit_equals(expected) && option("_kagiroi_ascii_input"),
                              "halfwidth addition must extend the complete retained display");
                        check(!option("_kagiroi_off_pending"), "halfwidth addition must clear the reservation");
                    } else if (keys[k] == kBackSpace) {
                        check(without_last_utf8_character(display, expected, sizeof(expected)) &&
                              preedit_equals(expected) && option("_kagiroi_ascii_input"),
                              "halfwidth Backspace must remove the last displayed character");
                        check(option("_kagiroi_off_pending"), "partial deletion must keep the reservation");
                    } else if (keys[k] == kEscape) {
                        check(!composing() && option("ascii_mode"), "reserved halfwidth Esc must enter IME OFF");
                    } else if (keys[k] == kReturn) {
                        check(!composing() && !option("ascii_mode") && !option("_kagiroi_ascii_input"),
                              "retained-list Enter must return to Japanese idle");
                        check(take_commit(commit, sizeof(commit)) && strcmp(commit, display) == 0,
                              "retained-list Enter must commit the complete display");
                    } else {
                        check(preedit_equals(display) && !option("_kagiroi_ascii_input") &&
                              option("_kagiroi_off_pending"),
                              "Japanese return must keep the display and reservation as preconversion text");
                        type_text("ki");
                        snprintf(expected, sizeof(expected), "%sき", display);
                        check(preedit_equals(expected), "resumed romaji must follow the fixed converted display");
                    }
                }
                if (keys[k] != kReturn)
                    check(!take_commit(commit, sizeof(commit)), "retained-list operations except Enter must not commit");
            }
        }
    }
}

static void test_off_reservation_and_fixed_text(void) {
    static const struct { const char* input; const char* ascii; const char* expected; } fixed[] = {
        {"k", "a", "kaき"}, {"kan", "A", "かnAき"}, {"", "Ab1", "Ab1き"},
    };
    for (size_t i = 0; i < sizeof(fixed) / sizeof(fixed[0]); ++i) {
        fresh_session();
        type_text(fixed[i].input);
        if (*fixed[i].input) press(kMuhenkan);
        else press_shift('A');
        type_text(*fixed[i].input ? fixed[i].ascii : fixed[i].ascii + 1);
        press(kZenkakuHankaku);
        type_text("ki");
        check(preedit_equals(fixed[i].expected), "Japanese resumption must not reinterpret retained ASCII or pending romaji");
    }
    fresh_session();
    type_text("kan");
    press(kMuhenkan);
    press(kReturn);
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "かn") == 0,
          "toggle followed by Enter must not complete the retained trailing n");
    fresh_session();
    type_text("kan");
    press_shift('A');
    press(kZenkakuHankaku);
    type_text("ki");
    check(preedit_equals("かnAき"), "Shift entry must also preserve unfinished romaji");

    for (int japanese = 0; japanese < 2; ++japanese) {
        for (int clear = 0; clear < 2; ++clear) {
            fresh_session();
            type_text("kana");
            press(kMuhenkan);
            if (japanese) press(kZenkakuHankaku);
            press(kLeft);
            if (japanese) press(kTab);
            check(option("_kagiroi_off_pending"), "caret movement and no-op Tab must preserve the reservation");
            if (clear) {
                press('1');
                check(!option("_kagiroi_off_pending"), "character addition must clear the reservation");
            }
            press(kBackSpace);
            check(composing(), "partial deletion must retain unconfirmed text");
            press(kEscape);
            check(!composing() && option("ascii_mode") == !clear,
                  "clearing either input mode must depend on reservation, not entry history");
        }
    }
    fresh_session();
    press_shift('A');
    press(kMuhenkan);
    check(option("_kagiroi_off_pending"), "Muhenkan must reserve OFF even after Shift entry");
    press(kMuhenkan);
    press(kBackSpace);
    check(!composing() && option("ascii_mode"), "repeated Muhenkan must keep the reservation");
    const int conversions[] = {kSpace, kHenkan};
    for (size_t i = 0; i < sizeof(conversions) / sizeof(conversions[0]); ++i) {
        fresh_session();
        type_text("ka");
        press(kMuhenkan);
        press(kZenkakuHankaku);
        press(conversions[i]);
        check(!option("_kagiroi_off_pending"), "conversion must clear the reservation");
        press(kEscape);
        press(kEscape);
        check(!composing() && !option("ascii_mode"), "deleting after conversion must end in Japanese idle");
    }
}

static void test_tail_editing_after_caret_movement(void) {
    static const struct { const char* input; const char* next; const char* expected; } cases[] = {
        {"kak", "i", "かき"}, {"kan", "ji", "かんじ"},
        {"kana", "1", "かな１"}, {"kana", ".", "かな。"}, {"kana", "-", "かなー"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        press(kLeft);
        type_text(cases[i].next);
        check(preedit_equals(cases[i].expected), "Japanese additions after Left must edit the tail");
    }
    for (int ascii = 0; ascii < 2; ++ascii) {
        fresh_session();
        type_text("kana");
        if (ascii) press(kMuhenkan);
        press(kLeft);
        press(kBackSpace);
        check(preedit_equals("か"), "Backspace after Left must delete the final Unicode character");
        if (ascii) {
            press(kLeft);
            type_text("ab");
            check(preedit_equals("かab"), "halfwidth additions after Left must append at the tail");
        }
    }
}

static void test_shift_preserves_every_state(void) {
    /* idle, typing, converted, collapsed/expanded list, halfwidth variants, OFF */
    for (int state = 0; state < 10; ++state) {
        fresh_session();
        if (state != 0 && state != 9) type_text("kyouhakare-");
        if ((state >= 2 && state <= 4) || (state >= 7 && state <= 8)) press(kSpace);
        if (state == 3 || state == 4 || state == 7 || state == 8) press(kSpace);
        if (state == 4 || state == 8) press(kTab);
        if (state >= 5) press(kMuhenkan);
        if (state == 6) { press(kZenkakuHankaku); press(kTab); }
        const int modifiers[] = {1, 1 << 30};
        for (size_t m = 0; m < sizeof(modifiers) / sizeof(modifiers[0]); ++m) {
            Bool off = option("ascii_mode"), ascii = option("_kagiroi_ascii_input");
            Bool pending = option("_kagiroi_off_pending"), expanded = option("_kagiroi_expand_candidates");
            RIME_STRUCT(RimeContext, before);
            RIME_STRUCT(RimeContext, after);
            check(current_menu(&before), "Shift setup context must be readable");
            press_modifier(kShiftL, modifiers[m]);
            check(current_menu(&after), "Shift result context must be readable");
            check(option("ascii_mode") == off && option("_kagiroi_ascii_input") == ascii &&
                  option("_kagiroi_off_pending") == pending && option("_kagiroi_expand_candidates") == expanded,
                  "Shift press/release must preserve mode, reservation and expansion");
            check(strcmp(before.composition.preedit ? before.composition.preedit : "",
                         after.composition.preedit ? after.composition.preedit : "") == 0 &&
                  strcmp(before.commit_text_preview ? before.commit_text_preview : "",
                         after.commit_text_preview ? after.commit_text_preview : "") == 0 &&
                  before.composition.cursor_pos == after.composition.cursor_pos &&
                  before.menu.num_candidates == after.menu.num_candidates &&
                  before.menu.page_no == after.menu.page_no &&
                  before.menu.highlighted_candidate_index == after.menu.highlighted_candidate_index,
                  "Shift press/release must preserve text, caret, list, page and selection");
            rime->free_context(&before);
            rime->free_context(&after);
            char commit[512];
            check(!take_commit(commit, sizeof(commit)), "Shift alone must never commit");
        }
    }
}

/* SPEC: F6-F10 do not perform character-type conversion in any IME ON
 * state. Only the absence of a conversion is observed: the displayed text
 * must stay identical. Other actions of these keys are unspecified and are
 * deliberately not asserted. */
static void test_function_keys_do_not_convert_text(void) {
    static const struct { int key; const char* name; } fkeys[] = {
        {kF6, "F6"}, {kF7, "F7"}, {kF8, "F8"}, {kF9, "F9"}, {kF10, "F10"},
    };
    /* idle, typing, hidden conversion, candidate list, halfwidth */
    for (int state = 0; state < 5; ++state) {
        for (size_t i = 0; i < sizeof(fkeys) / sizeof(fkeys[0]); ++i) {
            fresh_session();
            if (state >= 1) type_text("kyou");
            if (state >= 2) press(kSpace);
            if (state >= 3) press(kSpace);
            if (state == 4) press(kMuhenkan);
            /* Fail the setup loudly instead of passing the negative
             * assertion below vacuously on an empty composition. */
            if (state == 0) check(!composing(), "the F-key regression must start idle");
            if (state == 1) check(preedit_equals("きょう"),
                                  "the F-key regression must start from the hiragana reading");
            if (state == 2) check(composing() && menu_hidden(),
                                  "the F-key regression must start converted with the list closed");
            if (state == 3) check(!menu_hidden(),
                                  "the F-key regression must start with an open candidate list");
            if (state == 4) check(option("_kagiroi_ascii_input"),
                                  "the F-key regression must start in the halfwidth mode");
            RIME_STRUCT(RimeContext, before);
            check(current_menu(&before), "the F-key regression must start with a readable context");
            char before_preedit[512] = "";
            snprintf(before_preedit, sizeof(before_preedit), "%s",
                     before.composition.preedit ? before.composition.preedit : "");
            char before_preview[512] = "";
            snprintf(before_preview, sizeof(before_preview), "%s",
                     before.commit_text_preview ? before.commit_text_preview : "");
            rime->free_context(&before);
            check(state == 0 || before_preedit[0] != '\0' || before_preview[0] != '\0',
                  "the F-key regression must hold convertible text");
            press(fkeys[i].key);
            RIME_STRUCT(RimeContext, after);
            check(current_menu(&after), "the F-key regression must keep a readable context");
            char description[96];
            snprintf(description, sizeof(description),
                     "%s in state %d must not convert the displayed text", fkeys[i].name, state);
            check(strcmp(after.composition.preedit ? after.composition.preedit : "", before_preedit) == 0 &&
                      strcmp(after.commit_text_preview ? after.commit_text_preview : "", before_preview) == 0,
                  description);
            rime->free_context(&after);
        }
    }
}

static void normal_first(const char* reading, char* result, size_t size) {
    fresh_session();
    rime->set_input(session, reading);
    press(kHenkan);
    press(kSpace);
    preview_text(result, size);
}

static void test_typing_preview_is_reading(void) {
    static const struct { const char* input; const char* reading; } cases[] = {
        { "kyouhakare-", "きょうはかれー" },
        { "kan", "かn" },
        { "ka1q.", "か１q。" },
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        check(preview_equals(cases[i].reading), "typing preview must contain the reading, including pending n and mixed text");
        check(menu_hidden(), "typing preview must not expose a candidate menu");
    }
}

static Bool select_curry_emoji(char* expected, size_t size) {
    fresh_session();
    type_text("kyouhakare-");
    press(kSpace);
    press(kSpace);
    char prefix[256];
    selected_text(prefix, sizeof(prefix));
    /* Right moves the target to the curry clause and closes the list; Space
     * reopens that clause's list (dotfiles/rime/SPEC.md, "文節移動"). */
    press(kRight);
    press(kSpace);
    rime->set_option(session, "emoji", 1);
    check(option("emoji"), "the explicit option setting must enable the stock emoji filter");
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "the emoji clause must expose a menu");
        return False;
    }
    int emoji_index = -1, emoji_count = 0;
    for (int i = 0; i < context.menu.num_candidates; ++i) {
        if (strcmp(context.menu.candidates[i].text, "🍛") == 0) {
            emoji_index = i;
            ++emoji_count;
        }
    }
    check(emoji_count == 1, "stock uniquifier semantics must remove duplicate filtered emoji text");
    int count = context.menu.num_candidates;
    int initial = context.menu.highlighted_candidate_index;
    check(count == 10, "the filtered clause must expose ten final candidates before Tab");
    rime->free_context(&context);
    check(emoji_index >= 0, "the stock one-to-many filter must offer 🍛");
    if (emoji_index < 0) return False;
    int steps = (emoji_index - initial + count) % count;
    for (int i = 0; i < steps; ++i) press(kDown);
    char selected[256];
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, "🍛") == 0, "Down must select the actual filtered emoji");
    snprintf(expected, size, "%s🍛", prefix);
    check(preview_equals(expected), "emoji selection must update only the active clause in the full preview");
    return True;
}

static void test_bunsetsu_filtered_identity(void) {
    char expected[1024], selected[256], commit[1024];
    if (!select_curry_emoji(expected, sizeof(expected))) return;
    press(kTab);
    press(kRight);
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, "🍛") == 0 && preview_equals(expected) &&
              option("_kagiroi_expand_candidates") && !menu_hidden(),
          "an end-blocked move must retain the expanded list and the filtered emoji");
    press(kLeft);
    check(menu_hidden() && !option("_kagiroi_expand_candidates") && preview_equals(expected),
          "a successful move must close the list and keep the filtered choice");
    press(kRight);
    check(preview_equals(expected), "hidden Left/Right must retain the filtered emoji");
    press_shift(kTab);
    check(menu_hidden() && preview_equals(expected),
          "Shift+Tab with the list closed must change nothing");
    press(kSpace);
    press(kUp);
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, "🍛") == 0 && preview_equals(expected),
          "reopening and navigating back must use the retained final-filter position");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "Enter with the menu open must commit the full preview containing the emoji");

    if (!select_curry_emoji(expected, sizeof(expected))) return;
    press(kEscape);
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "Enter after closing the menu must commit the same filtered full preview");

    if (!select_curry_emoji(expected, sizeof(expected))) return;
    char prefix[1024], ordinary[1100];
    check(without_last_utf8_character(expected, prefix, sizeof(prefix)),
          "the selected emoji must have a removable codepoint");
    snprintf(ordinary, sizeof(ordinary), "%sカレー", prefix);
    rime->set_option(session, "emoji", 0);
    check(!option("emoji") && preview_equals(ordinary),
          "disabling emoji must refilter the selected clause using its genuine source");
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, "カレー") == 0, "the refiltered source choice must remain selectable");
    rime->set_option(session, "emoji", 1);
    check(option("emoji") && preview_equals(ordinary),
          "reenabling the filter must retain a still-present source selection");
    press(kEscape);
    press(kEscape);
    press(kSpace);
    check(menu_hidden(), "first conversion with emoji already enabled must keep the menu hidden");
    press(kRight);
    press(kSpace);
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, "🍛") == 0, "first conversion must collect filtered choices for every clause before reveal");
    preview_text(expected, sizeof(expected));
    press(kKeypadEnter);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "KP_Enter must also commit the filtered whole preview");

    /* Whole-text keys on the filtered preview: Backspace edits in place,
     * character keys commit the whole preview and restart
     * (dotfiles/rime/SPEC.md, "確定と次入力"). */
    static const struct { int key; const char* restart; } char_keys[] = {
        { '-', "ー" }, { '.', "。" }, { ',', "、" }, { '\'', "‘’" },
        { kKeypadDecimal, "." }, { 0xffac, "," },
    };
    for (int hidden = 0; hidden <= 1; ++hidden) {
        if (!select_curry_emoji(expected, sizeof(expected))) return;
        if (hidden) press(kEscape);
        char edited[1100];
        check(without_last_utf8_character(expected, edited, sizeof(edited)),
              "the filtered preview must contain a last Unicode character to remove");
        press(kBackSpace);
        check(preview_equals(edited) && menu_hidden() && composing(),
              "whole-text editing must use the filtered preview and return to hidden unconfirmed typing");
        check(!take_commit(commit, sizeof(commit)), "editing the filtered display must not commit");
        press(kReturn);
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, edited) == 0,
              "the edited filtered preview must commit unchanged");

        for (size_t i = 0; i < sizeof(char_keys) / sizeof(char_keys[0]); ++i) {
            if (!select_curry_emoji(expected, sizeof(expected))) return;
            if (hidden) press(kEscape);
            press(char_keys[i].key);
            check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
                  "character keys must commit the whole filtered preview");
            check(preedit_equals(char_keys[i].restart) && menu_hidden() && composing(),
                  "character keys must restart the input with their character");
            press(kReturn);
            check(take_commit(commit, sizeof(commit)) && strcmp(commit, char_keys[i].restart) == 0,
                  "the restarted characters must be committable as fresh text");
        }
    }
}

static void test_filtered_candidate_count_and_pages(void) {
    fresh_session();
    type_text("ka");
    press(kSpace);
    press(kSpace);
    rime->set_option(session, "emoji", 1);
    press(kTab);
    check(option("emoji"), "the expanded count test must keep the emoji option explicitly enabled");
    char choices[512][256];
    int total = 0;
    RimeCandidateListIterator iterator = {0};
    if (!rime->candidate_list_begin(session, &iterator)) {
        check(False, "the final filtered candidate iterator must be available");
        return;
    }
    while (total < 512 && rime->candidate_list_next(&iterator)) {
        snprintf(choices[total++], sizeof(choices[0]), "%s", iterator.candidate.text);
    }
    rime->candidate_list_end(&iterator);
    check(total > 30 && total < 512, "the filtered menu must have multiple pages within the test buffer");
    if (total <= 30 || total >= 512) return;
    Bool unique = True;
    for (int i = 0; i < total; ++i)
        for (int j = 0; j < i; ++j)
            if (strcmp(choices[i], choices[j]) == 0) unique = False;
    check(unique, "the complete filtered set must retain stock text-uniquifying behavior");
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) { check(False, "the expanded menu must remain available"); return; }
    int initial = context.menu.highlighted_candidate_index;
    rime->free_context(&context);
    for (int i = 0; i < initial; ++i) press(kUp);
    char selected[256];
    for (int i = 0; i < total; ++i) {
        selected_text(selected, sizeof(selected));
        check(strcmp(selected, choices[i]) == 0 && preview_equals(choices[i]),
              "expanded arrows must visit every final-filter candidate in actual menu order");
        press(kDown);
    }
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, choices[0]) == 0, "Down must wrap at the actual filtered candidate count");
    press(kUp);
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, choices[total - 1]) == 0, "Up must wrap to the final filtered candidate");
    press(kSpace);
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, choices[0]) == 0, "Space must wrap at the actual final-filter count");
    int last_page = (total - 1) / 30;
    for (int page = 0; page <= last_page; ++page) {
        if (page) press(kPageDown);
        if (!current_menu(&context)) { check(False, "paging must retain the filtered menu"); return; }
        int remaining = total - page * 30;
        int page_count = remaining < 30 ? remaining : 30;
        check(context.menu.page_no == page && context.menu.num_candidates == page_count
              && context.menu.is_last_page == (page == last_page),
              "page count and last-page status must match the complete final-filter set");
        char label[32];
        snprintf(label, sizeof(label), "Page %d", page + 1);
        check(context.menu.candidates[0].comment && strstr(context.menu.candidates[0].comment, label),
              "page comments must count the final-filter order");
        check(strcmp(context.menu.candidates[0].text, choices[page * 30]) == 0,
              "PageDown must start at the actual filtered page boundary");
        rime->free_context(&context);
    }
    /* PageDown past the last page wraps to the first page's head, and PageUp
     * before the first page wraps back to the last page's head
     * (dotfiles/rime/SPEC.md, "候補選択の循環"). */
    press(kPageDown);
    if (!current_menu(&context)) { check(False, "paging must retain the filtered menu"); return; }
    check(context.menu.page_no == 0 && context.menu.highlighted_candidate_index == 0 &&
              context.menu.candidates[0].text && strcmp(context.menu.candidates[0].text, choices[0]) == 0,
          "PageDown past the last filtered page must wrap to the first page's head");
    rime->free_context(&context);
    press(kPageUp);
    if (!current_menu(&context)) { check(False, "paging must retain the filtered menu"); return; }
    check(context.menu.page_no == last_page && context.menu.highlighted_candidate_index == 0 &&
              context.menu.candidates[0].text &&
              strcmp(context.menu.candidates[0].text, choices[last_page * 30]) == 0,
          "PageUp before the first filtered page must wrap to the last page's head");
    rime->free_context(&context);
    char preview[1024];
    preview_text(preview, sizeof(preview));
    press_shift(kTab);
    check(preview_equals(preview), "collapsing a filtered later page must retain its selection");
    if (current_menu(&context)) {
        int remaining = total - last_page * 30;
        check(context.menu.num_candidates == (remaining < 10 ? remaining : 10) && context.menu.is_last_page,
              "the collapsed window must contain at most ten actual final-filter candidates");
        rime->free_context(&context);
    }
    press(kTab);
    check(preview_equals(preview), "reexpanding must restore the same filtered later-page choice");
    for (int i = 0; i < last_page; ++i) press(kPageUp);
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, choices[0]) == 0, "PageUp must return to the first final-filter page");
}

static void test_bunsetsu_selection_and_preview(void) {
    fresh_session();
    type_text("kyouhakare-");
    press(kSpace);
    check(preedit_equals("今日はカレー") && preview_equals("今日はカレー"),
          "first Space must display all clauses' first candidates");
    check(menu_hidden(), "automatic conversion must keep the list hidden");
    press(kLeft);
    RIME_STRUCT(RimeContext, context);
    if (current_menu(&context)) {
        check(context.composition.sel_start == 0 && context.composition.sel_end == 9,
              "Left at the first clause must retain the first display interval");
        rime->free_context(&context);
    }
    press(kRight);
    press(kRight);
    if (current_menu(&context)) {
        check(context.composition.sel_start == 9 && context.composition.sel_end == 18,
              "Right must select the last clause and stop at the end");
        rime->free_context(&context);
    }
    check(preview_equals("今日はカレー"), "clause selection must preserve every candidate");
    press(kLeft);
    press(kSpace);
    check(active_reading_equals("きょうは"), "the first clause must read きょうは");
    if (current_menu(&context)) {
        check(context.menu.num_candidates > 0 && !menu_has_candidate(&context, "カレー"),
              "the first clause's list must exclude the other clause's candidates");
        rime->free_context(&context);
    }
    char left[256], right[256], current[256], selected[256], expected[1024], commit[1024];
    selected_text(left, sizeof(left));
    snprintf(expected, sizeof(expected), "%sカレー", left);
    check(preview_equals(expected), "candidate movement must update only the active clause's preview");

    /* A successful move with the list open closes it, clears the expansion
     * and returns to the hidden conversion, keeping every clause's choice
     * (dotfiles/rime/SPEC.md, "文節移動"). The following Down is unspecified
     * and stays untested. */
    press(kTab);
    press(kRight);
    check(menu_hidden() && !option("_kagiroi_expand_candidates") && preview_equals(expected),
          "Right with an expanded list must close it, clear the expansion and keep every choice");

    /* Right then Space opens the moved clause's list on its next candidate
     * (the SPEC example: 今日はかれー). */
    press(kSpace);
    check(active_reading_equals("かれー"), "Space after the move must open the moved clause's list");
    selected_text(current, sizeof(current));
    check(strcmp(current, "カレー") != 0,
          "Space must advance the moved clause from its kept first candidate");
    snprintf(expected, sizeof(expected), "%s%s", left, current);
    check(preview_equals(expected), "the moved clause's list must update only its own preview");
    press(kDown);
    selected_text(right, sizeof(right));
    snprintf(expected, sizeof(expected), "%s%s", left, right);
    check(preview_equals(expected), "Down must leave the first clause's choice unchanged");

    /* Moves while hidden keep the conversion hidden and the choices fixed. */
    press(kEscape);
    check(menu_hidden() && preview_equals(expected), "Esc must close the list without changing either choice");
    press(kLeft);
    press(kRight);
    check(menu_hidden() && preview_equals(expected),
          "hidden moves must keep the list closed and every clause's choice");

    /* A move blocked at the last clause keeps the open list, page, selection
     * and state; Space after closing advances from the kept choice. */
    press(kSpace);
    char kept[256], kept_preview[1024];
    selected_text(kept, sizeof(kept));
    preview_text(kept_preview, sizeof(kept_preview));
    if (!current_menu(&context)) {
        check(False, "the reopened list must stay readable");
        return;
    }
    int kept_page = context.menu.page_no;
    int kept_highlight = context.menu.highlighted_candidate_index;
    rime->free_context(&context);
    press(kRight);
    if (!current_menu(&context)) {
        check(False, "a blocked move must keep the list open");
        return;
    }
    check(context.menu.page_no == kept_page && context.menu.highlighted_candidate_index == kept_highlight,
          "Right blocked at the last clause must keep the open list and selection");
    rime->free_context(&context);
    check(preview_equals(kept_preview), "a blocked move must keep every clause's choice");
    press(kEscape);
    check(menu_hidden() && preview_equals(kept_preview), "Esc must close the list keeping the choices");
    press(kSpace);
    selected_text(selected, sizeof(selected));
    check(strcmp(selected, kept) != 0,
          "Space after closing the list must advance from the kept choice, not restart");
    press(kEscape);
    press(kEscape);
    check(preedit_equals("きょうはかれー") && menu_hidden(), "the next Esc must restore the entire reading");
    check(!take_commit(commit, sizeof(commit)), "selection and Esc must keep all clauses uncommitted");
}

static void test_bunsetsu_resize_and_retained_choices(void) {
    char left_first[256], right_first[256], shrunk_first[256], kare_first[256];
    char third[256], expected[1024], commit[1024];
    normal_first("きょうはか", left_first, sizeof(left_first));
    normal_first("れー", right_first, sizeof(right_first));
    normal_first("きょうは", shrunk_first, sizeof(shrunk_first));
    normal_first("かれー", kare_first, sizeof(kare_first));
    fresh_session();
    type_text("kyouhakare-12");
    press(kSpace);
    press(kRight);
    press(kRight);
    press(kSpace);
    check(active_reading_equals("１２"), "the third clause must read １２");
    selected_text(third, sizeof(third));
    check(strcmp(third, "12") == 0,
          "the reveal must select the third clause's second candidate");
    press(kEscape);
    snprintf(expected, sizeof(expected), "今日はカレー%s", third);
    check(menu_hidden() && preview_equals(expected),
          "Esc must close the list keeping every clause's choice");

    /* A hidden resize moves the boundary and reconverts both sides while the
     * list stays closed; the unrelated clause keeps its choice
     * (dotfiles/rime/SPEC.md, "境界変更"). */
    press(kLeft);
    press(kLeft);
    press_shift(kRight);
    snprintf(expected, sizeof(expected), "%s%s%s", left_first, right_first, third);
    check(menu_hidden() && preview_equals(expected),
          "a hidden resize must reset both affected sides and retain the unrelated choice");
    press(kSpace);
    check(active_reading_equals("きょうはか"),
          "the reopened list must expose the extended reading boundary");
    press(kEscape);
    press(kRight);
    press(kRight);
    RIME_STRUCT(RimeContext, context);
    if (current_menu(&context)) {
        const char* preedit = context.composition.preedit;
        int start = context.composition.sel_start;
        int end = context.composition.sel_end;
        check(preedit && end - start == (int)strlen(third) &&
                  strncmp(preedit + start, third, end - start) == 0,
              "the third clause must stay active with its retained choice");
        rime->free_context(&context);
    }

    /* Returning the boundary reconverts both sides again; Enter commits all
     * three choices in order. */
    press(kLeft);
    press(kLeft);
    press_shift(kLeft);
    snprintf(expected, sizeof(expected), "%s%s%s", shrunk_first, kare_first, third);
    check(preview_equals(expected),
          "both resized sides must return to first choices without losing the third");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "Enter must commit all three choices in order");

    /* A resize that actually moves the boundary closes an open list and
     * clears its expansion; a blocked resize keeps everything
     * (dotfiles/rime/SPEC.md, "境界変更"). */
    fresh_session();
    type_text("kyouhakare-12");
    press(kSpace);
    press(kSpace);
    press(kTab);
    check(option("_kagiroi_expand_candidates") && !menu_hidden(),
          "the open-resize test must start with an expanded list");
    press_shift(kRight);
    check(menu_hidden() && !option("_kagiroi_expand_candidates"),
          "a successful resize must close the list and clear the expansion");
    press(kRight);
    press(kRight);
    press(kSpace);
    press(kTab);
    check(option("_kagiroi_expand_candidates") && !menu_hidden(),
          "the blocked-resize test must reopen an expanded list on the last clause");
    char before[1024];
    preview_text(before, sizeof(before));
    press_shift(kRight);
    check(!menu_hidden() && option("_kagiroi_expand_candidates") && preview_equals(before),
          "extending the last clause must keep the list, expansion and choices");
}

static void test_bunsetsu_codepoint_limits_and_fallback(void) {
    static const char* const readings[] = {
        "きゃーＡ1☆", "きゃーＡ1", "きゃーＡ", "きゃー", "きゃ", "き",
    };
    fresh_session();
    rime->set_input(session, "きゃーＡ1☆𠮷");
    press(kHenkan);
    /* Resizes and moves that succeed close an open list, so the reading is
     * observed by reopening the active clause's list first
     * (dotfiles/rime/SPEC.md, "文節と境界変更"). */
    press_shift(kLeft);
    press(kSpace);
    check(active_reading_equals(readings[0]), "shortening the final clause must cut the astral codepoint into a new clause");
    for (size_t i = 1; i < sizeof(readings) / sizeof(readings[0]); ++i) {
        press_shift(kLeft);
        press(kSpace);
        check(active_reading_equals(readings[i]), "shortening must count symbols, digits, letters, long marks and small kana separately");
    }
    press_shift(kLeft);
    check(active_reading_equals("き"), "a one-codepoint clause must not shorten");
    press(kRight);
    press(kSpace);
    check(active_reading_equals("ゃーＡ1☆𠮷"), "all transferred codepoints must join the next clause in order");
    press_shift(kRight);
    check(active_reading_equals("ゃーＡ1☆𠮷"), "the last clause must not extend without a following clause");
    press(kLeft);
    for (int i = 0; i < 6; ++i) press_shift(kRight);
    press(kSpace);
    check(active_reading_equals("きゃーＡ1☆𠮷"), "extension must absorb and remove an emptied neighboring clause");
    press(kRight);
    check(active_reading_equals("きゃーＡ1☆𠮷"), "the removed clause must not remain selectable");
    char commit[1024];
    check(!take_commit(commit, sizeof(commit)), "every boundary edit must remain uncommitted");

    fresh_session();
    rime->set_input(session, "ぁゃ𠮷");
    press(kSpace);
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (current_menu(&context)) {
        check(context.menu.num_candidates == 1 && menu_has_candidate(&context, "ぁゃ"),
              "a dictionary-less kana clause must expose only its reading");
        rime->free_context(&context);
    }
    press(kRight);
    press(kSpace);
    check(active_reading_equals("𠮷"), "a dictionary-less astral clause must remain independently selectable");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "ぁゃ𠮷") == 0,
          "Enter must include all dictionary-less readings");
}

static void test_bunsetsu_whole_edit_and_commit(void) {
    char display[1024], expected[1100], commit[1100];
    /* Character keys during conversion commit the whole displayed
     * conversion and restart the input with their character
     * (dotfiles/rime/SPEC.md, "確定と次入力"). */
    static const struct { int key; const char* restart; } appends[] = {
        {',', "、"}, {'.', "。"}, {'-', "ー"}, {'=', "＝"}, {'$', "＄"},
        {'\'', "‘’"}, {'"', "“”"}, {'/', "・"},
        {kKeypadDecimal, "."}, {0xffac, ","}, {0xffaa, "*"}, {kKeypad1, "1"},
    };
    for (int visible = 0; visible <= 1; ++visible) {
        for (size_t i = 0; i < sizeof(appends) / sizeof(appends[0]); ++i) {
            fresh_session();
            type_text("kyouhakare-");
            press(kSpace);
            if (visible) { press(kSpace); press(kTab); }
            preview_text(display, sizeof(display));
            press(appends[i].key);
            check(take_commit(commit, sizeof(commit)) && strcmp(commit, display) == 0,
                  "character keys must commit all clauses' current choices together");
            check(preedit_equals(appends[i].restart) && menu_hidden(),
                  "character keys must restart the input with their character and close the list");
            check(!option("_kagiroi_expand_candidates"),
                  "the commit must release expansion");
        }
        fresh_session();
        type_text("kyouhakare-");
        press(kSpace);
        if (visible) press(kSpace);
        preview_text(display, sizeof(display));
        without_last_utf8_character(display, expected, sizeof(expected));
        press(kBackSpace);
        check(preedit_equals(expected) && menu_hidden(), "Backspace must delete the whole display's final codepoint");
        check(!take_commit(commit, sizeof(commit)), "Backspace must not commit a preceding clause");

        fresh_session();
        type_text("kyouhakare-");
        press(kSpace);
        if (visible) press(kSpace);
        char shift_display[512], shift_expected[1024];
        preview_text(shift_display, sizeof(shift_display));
        snprintf(shift_expected, sizeof(shift_expected), "%sA", shift_display);
        press_shift('A');
        check(preedit_equals(shift_expected) && option("_kagiroi_ascii_input"),
              "Shift+letter must retain the converted display in halfwidth input");
        check(!take_commit(commit, sizeof(commit)), "Shift+letter must not commit any clause");

        static const int restart[] = { 'a', '2', kKeypad1, kReturn, kKeypadEnter };
        static const char* const restarted[] = { "あ", "２", "1", "", "" };
        for (size_t i = 0; i < sizeof(restart) / sizeof(restart[0]); ++i) {
            fresh_session();
            type_text("kyouhakare-");
            press(kSpace);
            if (visible) { press(kSpace); press(kRight); press(kDown); }
            preview_text(display, sizeof(display));
            press(restart[i]);
            check(take_commit(commit, sizeof(commit)) && strcmp(commit, display) == 0,
                  "confirmation keys must commit all clauses' current choices together");
            check(preedit_equals(restarted[i]) || (restarted[i][0] == '\0' && !composing()),
                  "typing confirmation must restart the pressed key, while Enter must leave no composition");
        }
    }

    /* A single-candidate clause follows the same commit and restart. */
    fresh_session();
    rime->set_input(session, "ぁゃ");
    press(kSpace);
    preview_text(display, sizeof(display));
    check(strcmp(display, "ぁゃ") == 0, "the single-candidate setup must display its reading");
    press('-');
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "ぁゃ") == 0,
          "character keys must commit a single-candidate clause's whole display");
    check(preedit_equals("ー") && menu_hidden(),
          "the single-candidate restart must open with the character");
}

static void test_bunsetsu_henkan_exception_and_expansion(void) {
    fresh_session();
    type_text("kyouhakare-");
    press(kHenkan);
    check(preedit_equals("キョウハカレー") && menu_hidden(), "Henkan must initially display the complete katakana reading");
    press(kSpace);
    char first[1024];
    preview_text(first, sizeof(first));
    check(first[0] != '\0' && strcmp(first, "キョウハカレー") != 0 && menu_hidden(),
          "Space after Henkan must show a normal candidate without opening the list");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (current_menu(&context)) {
        check(context.menu.num_candidates > 0 && strcmp(context.menu.candidates[0].text, first) == 0,
              "the hidden normal conversion must have selected the whole reading\'s first candidate");
        rime->free_context(&context);
    }
    check(active_reading_equals("きょうはかれー"), "Henkan conversion must remain a single whole-reading clause");
    press(kRight);
    check(active_reading_equals("きょうはかれー"), "Right must stop at the only Henkan clause");

    fresh_session();
    type_text("ka12");
    press(kSpace);
    press(kSpace);
    press(kTab);
    /* Expanded PageDown selects the destination page's first candidate. */
    press(kPageDown);
    char before[1024];
    preview_text(before, sizeof(before));
    press_shift(kTab);
    check(preview_equals(before), "collapsing a later page must preserve the selected candidate");
    press(kTab);
    check(!menu_hidden() && option("_kagiroi_expand_candidates"),
          "reexpanding must restore the expanded list");
    press(kRight);
    press(kLeft);
    check(menu_hidden() && preview_equals(before),
          "clause moves must close the list and keep every clause's choice");
    press(kSpace);
    press(kPageUp);
    char selected[256], expected[1024];
    selected_text(selected, sizeof(selected));
    snprintf(expected, sizeof(expected), "%s１２", selected);
    check(preview_equals(expected), "paging must update only the target clause's preview");
    if (current_menu(&context)) {
        check(context.menu.highlighted_candidate_index == 0 && context.menu.page_no == 0,
              "PageUp must select the previous page's first candidate");
        rime->free_context(&context);
    }
}

static void test_bunsetsu_hidden_resize_and_hiragana(void) {
    char first[256], next[256], expected[1024], commit[1024];
    normal_first("きょうはか", first, sizeof(first));
    normal_first("れー", next, sizeof(next));
    fresh_session();
    type_text("kyouhakare-12");
    press(kSpace);
    press(kRight);
    press(kRight);
    press(kSpace);
    press(kEscape);
    press(kLeft);
    press(kLeft);
    press_shift(kRight);
    snprintf(expected, sizeof(expected), "%s%s12", first, next);
    check(menu_hidden() && preview_equals(expected),
          "hidden resizing must reset both sides and retain the third clause's choice");
    press(kSpace);
    check(active_reading_equals("きょうはか"),
          "the reopened hidden resize must expose the extended reading boundary");
    check(!take_commit(commit, sizeof(commit)), "hidden resizing must not commit any clause");

    fresh_session();
    rime->set_input(session, "ヴぁＡ1☆");
    press(kSpace);
    press(kEscape);
    check(preedit_equals("ゔぁＡ1☆"),
          "Esc must restore hiragana while preserving mixed letters, digits and symbols");
}

static void test_bunsetsu_contexts_keep_separate_choices(void) {
    fresh_session();
    type_text("kyouhakare-");
    press(kSpace);
    char first_display[256];
    preview_text(first_display, sizeof(first_display));
    RimeSessionId first = session;
    session = 0;
    fresh_session();
    type_text("kanji");
    press(kSpace);
    char second_display[256], commit[256];
    preview_text(second_display, sizeof(second_display));
    RimeSessionId second = session;
    session = first;
    press(kZenkakuHankaku);
    check(preview_equals(first_display) && option("_kagiroi_ascii_input"),
          "the ascii toggle must retain its own context's complete display");
    session = second;
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, second_display) == 0,
          "restoring another context must not change this context's conversion");
    rime->destroy_session(first);
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
    g_user_data_dir = user_data_dir;

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
        /* Runs first: later tests feed the user dictionary and can saturate
         * the learned order the baseline comparison depends on. */
        test_learning_promotes_committed_candidate,
        test_default_schema_is_kagiroi,
        test_main_dictionary_imports_managed_custom_table,
        test_ascii_punct_disabled_at_session_start,
        test_emoji_option_defaults_off,
        test_n_run_correction,
        test_n_run_preedit,
        test_n_run_conversion_reading,
        test_kan_space_starts_conversion,
        test_conversion_correction_after_caret_move,
        test_left_shift_keeps_mode_and_composition,
        test_shift_preserves_every_state,
        test_function_keys_do_not_convert_text,
        test_ahk_shift_l_equal_sequence_stays_japanese,
        test_zenkaku_hankaku_toggles_ascii,
        test_zenkaku_hankaku_keeps_composition,
        test_kana_muhenkan_one_way_switches,
        test_ascii_off_reservation_exits,
        test_idle_space_commits_full_width,
        test_digit_and_keypad_symbol_keys,
        test_symbols_append_unconfirmed,
        test_appends_accumulate,
        test_keypad_symbols_in_conversion_states,
        test_space_after_append_converts_uncommitted,
        test_romaji_after_keypad_digits_resumes_kana,
        test_fullwidth_digit_then_romaji_suffix,
        test_ascii_keypad_vowels_preserved_on_kana_resumption,
        test_quote_pairs,
        test_minus_equal_commit_and_restart,
        test_shift_letter_switches_ascii_mode,
        test_ascii_mode_passes_half_width_keys,
        test_ascii_variants_candidates,
        test_henkan_promotes_katakana,
        test_henkan_space_enter_chain,
        test_backspace_escape_return_to_reading,
        test_typing_key_confirms_selection,
        test_punctuation_commits_and_restarts,
        test_menu_esc_keeps_conversion,
        test_tab_expands_candidates,
        test_page_size_is_30,
        test_page_cycling_selects_heads,
        test_henkan_typing_key_confirms,
        test_typing_hides_candidates,
        test_first_space_converts_to_first_candidate,
        test_space_cycles_candidates,
        test_arrow_navigation_across_pages,
        test_arrow_caret_and_segments,
        test_listed_shortcuts_pass_through,
        test_modifier_shortcuts_do_not_page,
        test_minus_equal_on_second_page,
        test_enter_commits_highlighted_candidate,
        test_punctuation_appends_unconfirmed,
        test_romanization_matches_declaration,
        test_romaji_dictionary_is_declaration_only,
        test_nn_pair_consumption,
        test_longest_declared_suffix_preserves_raw_prefix,
        test_sokuon_hatsuon_and_long_vowel,
        test_typing_preview_is_reading,
        test_bunsetsu_selection_and_preview,
        test_bunsetsu_resize_and_retained_choices,
        test_bunsetsu_codepoint_limits_and_fallback,
        test_bunsetsu_whole_edit_and_commit,
        test_bunsetsu_henkan_exception_and_expansion,
        test_bunsetsu_hidden_resize_and_hiragana,
        test_bunsetsu_contexts_keep_separate_choices,
        test_bunsetsu_filtered_identity,
        test_filtered_candidate_count_and_pages,
        test_tail_editing_after_caret_movement,
        test_off_reservation_and_fixed_text,
        test_retained_list_transitions,
    };
    for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); ++i) {
        tests[i]();
    }

    if (session) rime->destroy_session(session);
    rime->finalize();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
