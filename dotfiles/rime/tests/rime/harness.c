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
#define kHiraganaKatakana 0xff27
#define kBackSpace 0xff08
#define kEscape 0xff1b
#define kKeypadDecimal 0xffae
#define kKeypadEnter 0xff8b
#define kKeypad1 0xffb1
#define kTab 0xff09
#define kUp 0xff52
#define kDown 0xff54
#define kLeft 0xff51
#define kRight 0xff53
#define kPageUp 0xff55
#define kPageDown 0xff56

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

/* SPEC: accepted n-run forms expose a candidate containing the reading's
 * dictionary word. Readings without a matching dictionary word (こにちは,
 * かんあ, かんだ, にゃ) are checked as preedit in test_n_run_preedit and
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

/* SPEC: accepted n-run forms read exactly as the SPEC table says while
 * composing; excessive n runs are not corrected while typing. */
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
        {"kana", "かな"},
        {"kanna", "かんあ"},
        {"kannna", "かんな"},
        {"kannnna", "かんんあ"},
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

/* SPEC: n followed by Space resolves to ん and starts the conversion; the
 * list stays hidden and Esc restores the corrected reading. */
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

    /* SPEC: the n-run correction happens at conversion only; Enter while
     * typing commits the raw reading. */
    fresh_session();
    type_text("kan");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "かn") == 0,
          "Enter while typing must commit the raw reading without the n correction");
    check(!composing(), "the commit must end the composition");
}

/* SPEC: Space converts with the corrected reading: consecutive ん fold into
 * one and a leftover ん binds with a following vowel. Esc restores the
 * unconfirmed conversion to the corrected hiragana reading. */
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
        {"kannnji", "かんじ"},
        {"kanda", "かんだ"},
        {"kannda", "かんだ"},
        {"kannnda", "かんだ"},
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

    /* Converted state: the inline display returns to the reading for the
     * ascii input mode. */
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kZenkakuHankaku);
    check(option("_kagiroi_ascii_input"), "the toggle must enter the ascii input mode from the conversion");
    check(!take_commit(commit, sizeof(commit)), "the toggle must not commit the conversion");
    check(preedit_equals("かんじ"), "the toggle must return to the reading for the ascii input mode");
    press(kZenkakuHankaku);
    check(!option("_kagiroi_ascii_input"), "the toggle must restore the Japanese mode");
    press(kEscape);
    check(!composing(), "Esc must clear the composition after the round trip");

    /* Henkan state: the katakana display returns to the reading for the
     * ascii input mode. */
    fresh_session();
    type_text("kana");
    press(kHenkan);
    press(kZenkakuHankaku);
    check(option("_kagiroi_ascii_input"), "the toggle must enter the ascii input mode from Henkan");
    check(!take_commit(commit, sizeof(commit)), "the toggle must not commit the Henkan katakana");
    check(preedit_equals("かな"), "the toggle must return to the reading from Henkan");
    check(!option("katakana"), "the toggle must restore the kana mode from Henkan");
    press(kZenkakuHankaku);
    check(!option("_kagiroi_ascii_input"), "the toggle must restore the Japanese mode");
    type_text("moji");
    check(preedit_equals("かなもじ"), "typing after the round trip must convert behind the tail");
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

/* SPEC: main-row digits append their full-width form and keypad digits and
 * KP_Decimal append their own form while idle or typing; during conversion
 * and with the menu visible the keys confirm the unconfirmed string and
 * start a fresh input (dotfiles/rime/SPEC.md). */
static void test_digits_append_unconfirmed(void) {
    static const struct {
        int key;
        const char* appended;
    } cases[] = {
        {'0', "０"}, {'1', "１"}, {'2', "２"}, {'3', "３"}, {'4', "４"},
        {'5', "５"}, {'6', "６"}, {'7', "７"}, {'8', "８"}, {'9', "９"},
        {0xffb0, "0"}, {kKeypad1, "1"}, {0xffb2, "2"}, {0xffb3, "3"},
        {0xffb4, "4"}, {0xffb5, "5"}, {0xffb6, "6"}, {0xffb7, "7"},
        {0xffb8, "8"}, {0xffb9, "9"}, {kKeypadDecimal, "．"},
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
                check(selected[0] != '\0', "the selection must exist before the digit");
            } else if (state == 1) {
                snprintf(expected, sizeof(expected), "%s", "かんじ");
            }
            press(cases[i].key);
            char commit[256];
            char description[128];
            if (state == 2) {
                /* The key confirms the selection and starts a fresh input. */
                snprintf(expected, sizeof(expected), "%s", cases[i].appended);
                snprintf(description, sizeof(description), "key %x in state %d must start a fresh input with its width",
                         cases[i].key, state);
                check(preedit_equals(expected), description);
                check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
                      "key during conversion must commit the selected candidate");
            } else {
                size_t used = strlen(expected);
                snprintf(expected + used, sizeof(expected) - used, "%s", cases[i].appended);
                snprintf(description, sizeof(description), "key %x in state %d must append its width",
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
}

/* SPEC: after Henkan, Space keeps the first candidate selected with the
 * list hidden, Enter commits the katakana, and the next typing hides
 * candidates again. */
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
        check(False, "the conversion must survive Space after Henkan");
        return;
    }
    check(composing(), "Space after Henkan must keep the composition open");
    check(context.menu.num_candidates == 0,
          "Space after Henkan must keep the candidate list hidden");
    check(context.composition.preedit &&
              strcmp(context.composition.preedit, "カンジ") == 0,
          "Space after Henkan must keep the katakana first candidate selected");
    rime->free_context(&context);
    press(kReturn);
    check(composing() == False, "Enter after Henkan must end the composition");
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "カンジ") == 0,
          "Enter must commit the katakana kept after Henkan");
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

    /* Backspace also deletes the kept katakana after Space leaves Henkan's
     * conversion hidden. */
    fresh_session();
    type_text("kanji");
    press(kHenkan);
    press(kSpace);
    if (current_menu(&context)) {
        check(context.menu.num_candidates == 0 &&
                  context.composition.preedit &&
                  strcmp(context.composition.preedit, "カンジ") == 0,
              "Space after Henkan must keep the katakana conversion hidden");
        rime->free_context(&context);
    } else {
        check(False, "the kept Henkan conversion must keep a queryable context");
    }
    press(kBackSpace);
    check(preedit_equals("カン"),
          "Backspace in the kept Henkan conversion must remove the last katakana character");
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
 * SPEC: comma and period with a selection append the punctuation to the
 * converted text without committing it and end the conversion mode
 * (dotfiles/rime/SPEC.md, "句読点").
 */
static void test_comma_period_append_to_selection(void) {
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
                 "%s with the menu visible must append %s to the selection",
                 cases[i].name, cases[i].punct);
        check(preedit_equals(expected), description);
        snprintf(description, sizeof(description),
                 "%s with the menu visible must not commit", cases[i].name);
        check(!take_commit(commit, sizeof(commit)), description);
        if (!current_menu(&context)) {
            check(False, "the append must keep a queryable context");
            return;
        }
        check(context.menu.num_candidates == 0,
              "the append must end the conversion mode and hide the list");
        rime->free_context(&context);
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
        char expected[288];
        snprintf(expected, sizeof(expected), "%s%s", first, cases[i].punct);
        char description[128];
        snprintf(description, sizeof(description),
                 "%s after the first Space must append %s to the display",
                 cases[i].name, cases[i].punct);
        check(preedit_equals(expected), description);
        char commit[256];
        check(!take_commit(commit, sizeof(commit)),
              "the punctuation key must not commit the conversion");
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
    check(context.menu.page_no == 1, "PageDown must move to the next page");
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
    check(context.menu.page_no == 0 && context.select_labels &&
              strcmp(context.select_labels[0], "1") == 0,
          "PageUp must return to the first page and its labels");
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
    /* The second Space reveals the character-type candidates of the digit. */
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

/* SPEC: romaji typed after an append keeps its raw form instead of being
 * converted to kana. */
static void test_romaji_after_append_stays_raw(void) {
    fresh_session();
    type_text("kanji");
    press(kKeypad1);
    type_text("a");
    check(preedit_equals("かんじ1a"), "romaji after an append must stay raw");
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

/* SPEC: - and = never page a visible menu; during conversion they confirm
 * the selection and start a fresh input with their symbol. A minus while
 * reading still appends the long vowel to the reading. */
static void test_minus_equal_do_not_page(void) {
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
        check(preedit_equals(cases[i].symbol),
              "minus/equal must start a fresh input with its symbol rather than page");
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
              "minus/equal must commit the selection");
    }
    fresh_session();
    type_text("kana");
    press('-');
    check(preedit_equals("かなー"), "minus during reading must append ー");
}

/* SPEC: the ascii input mode appends half-width letters, digits, symbols and
 * the space to the unconfirmed composition (dotfiles/rime/SPEC.md). */
static void test_ascii_mode_passes_half_width_keys(void) {
    fresh_session();
    press_shift('A');
    check(option("_kagiroi_ascii_input"),
          "the test must enter the ascii input mode before typing");
    const int keys[] = {'a', '1', '$', kSpace, kKeypad1, kKeypadDecimal};
    static const char* const texts[] = {"a", "1", "$", " ", "1", "."};
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
        check(rime->process_key(session, keys[i], 0),
              "the ascii input mode must consume half-width typing");
        char commit[256];
        check(!take_commit(commit, sizeof(commit)),
              "the ascii input mode must not commit a half-width character");
    }
    check(preedit_equals("Aa1$ 1."),
          "the ascii input mode must accumulate the half-width text");
    check(composing(), "the ascii input mode must keep the composition open");
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

    /* From the hidden conversion the reading is restored and kept. */
    fresh_session();
    type_text("kana");
    press(kSpace);
    press_shift('A');
    check(option("_kagiroi_ascii_input"),
          "Shift+A from the hidden conversion must enter the ascii input mode");
    check(preedit_equals("かなA"),
          "Shift+A from the hidden conversion must restore the reading and append A");

    /* From the open menu the reading is restored and kept. */
    fresh_session();
    type_text("kana");
    press(kSpace);
    press(kSpace);
    press_shift('A');
    check(option("_kagiroi_ascii_input"),
          "Shift+A from the open menu must enter the ascii input mode");
    check(preedit_equals("かなA"),
          "Shift+A from the open menu must restore the reading and append A");

    /* Half-width typing continues behind the fixed tail in the mode. */
    press('1');
    check(preedit_equals("かなA1"), "typing in the mode must append half-width digits");
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "the mode switch must not commit");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "かなA1") == 0,
          "Enter in the mode must commit the whole unconfirmed string");
    check(!option("_kagiroi_ascii_input"), "the commit must leave the mode");
}

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
        {"hwa", "ふぁ"}, {"cwa", "くぁ"}, {"bwa", "ぶぁ"},
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

/* SPEC: the keypad separator appends the full-width comma while idle and
 * typing, confirms the conversion with the menu open or hidden, and stays
 * half-width inside the ascii input mode (dotfiles/rime/SPEC.md). */
static void test_kp_separator_appends(void) {
    static const int kKeypadSeparator = 0xffac;
    char commit[256];

    fresh_session();
    press(kKeypadSeparator);
    check(preedit_equals("，"), "the keypad separator while idle must append ，");
    check(!take_commit(commit, sizeof(commit)), "the idle keypad separator must not commit");

    fresh_session();
    type_text("kanji");
    press(kKeypadSeparator);
    check(preedit_equals("かんじ，"), "the keypad separator while typing must append ，");
    check(!take_commit(commit, sizeof(commit)), "the keypad separator must not commit the reading");

    /* From the hidden conversion the key confirms and starts a fresh input. */
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kKeypadSeparator);
    check(take_commit(commit, sizeof(commit)),
          "the keypad separator from the hidden conversion must confirm it");
    check(preedit_equals("，"), "the confirmation must start a fresh input with ，");

    /* With the menu visible the key confirms the selection likewise. */
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
    check(selected[0] != '\0', "the menu must hold a selection for the separator");
    press(kKeypadSeparator);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
          "the keypad separator with the menu visible must confirm the selection");
    check(preedit_equals("，"), "the separator must start a fresh input with ，");

    /* Inside the ascii input mode the separator stays half-width. */
    fresh_session();
    press_shift('A');
    press(kKeypadSeparator);
    check(preedit_equals("A,"), "the keypad separator in the mode must append a half-width comma");
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

    /* During the hidden conversion Left selects the previous segment and
     * Right returns; Shift+Left and Shift+Right resize the selection. */
    fresh_session();
    type_text("kanjimoji");
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the hidden conversion must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates == 0,
          "the conversion under the arrow test must keep the list hidden");
    size_t caret = context.composition.cursor_pos;
    int sel_start = context.composition.sel_start;
    int sel_end = context.composition.sel_end;
    rime->free_context(&context);
    press(kLeft);
    if (!current_menu(&context)) {
        check(False, "Left during conversion must keep a queryable context");
        return;
    }
    check(context.composition.cursor_pos < caret
              && context.composition.sel_end <= sel_end,
          "Left during conversion must select the previous conversion segment");
    size_t moved_caret = context.composition.cursor_pos;
    int moved_sel_end = context.composition.sel_end;
    rime->free_context(&context);
    rime->process_key(session, kLeft, 1);
    if (!current_menu(&context)) {
        check(False, "Shift+Left during conversion must keep a queryable context");
        return;
    }
    check(context.composition.cursor_pos < moved_caret
              && context.composition.sel_end < moved_sel_end,
          "Shift+Left during conversion must shorten the selected segment");
    rime->free_context(&context);
    rime->process_key(session, kRight, 1);
    if (!current_menu(&context)) {
        check(False, "Shift+Right during conversion must keep a queryable context");
        return;
    }
    check(context.composition.cursor_pos == moved_caret
              && context.composition.sel_end == moved_sel_end,
          "Shift+Right during conversion must extend the segment back");
    rime->free_context(&context);
    press(kRight);
    if (!current_menu(&context)) {
        check(False, "Right during conversion must keep a queryable context");
        return;
    }
    check(context.composition.cursor_pos == caret,
          "Right during conversion must return to the last segment");
    rime->free_context(&context);

    /* With the menu open Left moves the block selection backwards. */
    fresh_session();
    type_text("kanjimoji");
    press(kSpace);
    press(kSpace);
    if (!current_menu(&context)) {
        check(False, "the open menu must keep a queryable context");
        return;
    }
    size_t menu_caret = context.composition.cursor_pos;
    check(context.menu.num_candidates > 0, "the menu must be open for the arrow test");
    rime->free_context(&context);
    press(kLeft);
    if (!current_menu(&context)) {
        check(False, "Left with the menu open must keep a queryable context");
        return;
    }
    check(context.composition.cursor_pos < menu_caret,
          "Left with the menu open must select the previous block");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "the arrow keys must not commit");
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

/* SPEC: the way into the ascii input mode decides where an emptied string
 * continues: the toggle keys lead to IME OFF and Shift+letter back to the
 * Japanese input; Enter commits and returns to the Japanese input either
 * way (dotfiles/rime/SPEC.md). */
static void test_ascii_mode_origin_exits(void) {
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

/*
 * SPEC: the nn pair is consumed as ん on the second keypress, without
 * adding n to the next vowel or y. Enter commits the converted reading
 * (dotfiles/rime/SPEC.md, n の過不足補完).
 */
static void test_nn_pair_consumption(void) {
    char commit[256];
    fresh_session();
    type_text("n");
    check(preedit_equals("n"), "a lone n must stay pending while typing");
    type_text("n");
    check(preedit_equals("ん"), "nn must read ん on the second keypress");
    press(kSpace);
    check(preedit_equals("ん"), "nn + Space must keep reading ん");
    fresh_session();
    type_text("nn");
    press(kReturn);
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, "ん") == 0,
          "nn + Enter must commit ん");
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
    /* a four-n run keeps both ん (no rebind) */
    fresh_session();
    type_text("kannnna");
    check(preedit_equals("かんんあ"), "kannnna must read かんんあ");
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

/* SPEC: after the reveal, later Spaces move the selection and wrap past the
 * final candidate. */
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
    int count = context.menu.num_candidates;
    check(context.menu.highlighted_candidate_index == 1,
          "the reveal must highlight the second candidate");
    rime->free_context(&context);
    check(count > 2, "the menu must hold more than two candidates for cycling");
    for (int presses = 1; presses < count; ++presses) {
        press(kSpace);
        if (!rime->get_context(session, &context)) {
            check(False, "the menu must survive cycling");
            return;
        }
        int expected = (1 + presses) % count;
        check(context.menu.highlighted_candidate_index == expected,
              "Space must advance the highlight and wrap to the first candidate");
        rime->free_context(&context);
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
    check(context.menu.page_no == 1, "PageDown must reach the second page");
    rime->free_context(&context);
    press(kPageUp);
    if (!current_menu(&context)) {
        check(False, "PageUp must preserve the candidate menu");
        return;
    }
    check(context.menu.page_no == 0, "PageUp must return to the first page");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)) && composing(),
          "candidate navigation must leave the composition uncommitted");
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

/* SPEC: - and = on a second page confirm the selected candidate and start a
 * fresh input with their symbol instead of paging. */
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
        check(preedit_equals(cases[i].symbol),
              "minus/equal on page two must start a fresh input rather than page");
        check(take_commit(commit, sizeof(commit)) && strcmp(commit, selected) == 0,
              "minus/equal on page two must commit the selection");
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
 * and promotes it in the menu for the same reading. */
static void test_learning_promotes_committed_candidate(void) {
    RIME_STRUCT(RimeContext, context);
    char baseline_first[128] = "";

    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kSpace);
    if (current_menu(&context) && context.menu.num_candidates > 0
        && context.menu.candidates[0].text) {
        snprintf(baseline_first, sizeof(baseline_first), "%s",
                 context.menu.candidates[0].text);
        rime->free_context(&context);
    } else {
        rime->free_context(&context);
        check(False, "the menu must exist before learning");
        return;
    }

    /* Commit the second candidate repeatedly. Which word the second rank
     * holds may shift once learning kicks in, but every commit feeds the
     * user dictionary. */
    char commit[256];
    for (int i = 0; i < 5; ++i) {
        fresh_session();
        type_text("kanji");
        press(kSpace);
        press(kSpace);
        press(kDown);
        press(kReturn);
        take_commit(commit, sizeof(commit));
    }

    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kSpace);
    char after_first[128] = "";
    if (current_menu(&context) && context.menu.num_candidates > 0
        && context.menu.candidates[0].text) {
        snprintf(after_first, sizeof(after_first), "%s",
                 context.menu.candidates[0].text);
        rime->free_context(&context);
    } else {
        rime->free_context(&context);
        check(False, "the menu must exist after learning");
        return;
    }
    check(strcmp(baseline_first, after_first) != 0,
          "repeated commits must promote a learned candidate above the baseline first");
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
        /* Runs first: later tests feed the user dictionary and can saturate
         * the learned order the baseline comparison depends on. */
        test_learning_promotes_committed_candidate,
        test_default_schema_is_kagiroi,
        test_ascii_punct_disabled_at_session_start,
        test_n_run_correction,
        test_n_run_preedit,
        test_n_run_conversion_reading,
        test_kan_space_starts_conversion,
        test_zenkaku_hankaku_toggles_ascii,
        test_zenkaku_hankaku_keeps_composition,
        test_kana_muhenkan_one_way_switches,
        test_ascii_mode_origin_exits,
        test_idle_space_commits_full_width,
        test_digits_append_unconfirmed,
        test_symbols_append_unconfirmed,
        test_appends_accumulate,
        test_kp_separator_appends,
        test_space_after_append_converts_uncommitted,
        test_romaji_after_append_stays_raw,
        test_quote_pairs,
        test_minus_equal_do_not_page,
        test_shift_letter_switches_ascii_mode,
        test_ascii_mode_passes_half_width_keys,
        test_ascii_variants_candidates,
        test_henkan_promotes_katakana,
        test_henkan_space_enter_chain,
        test_backspace_escape_return_to_reading,
        test_typing_key_confirms_selection,
        test_comma_period_append_to_selection,
        test_menu_esc_keeps_conversion,
        test_tab_expands_candidates,
        test_page_size_is_30,
        test_henkan_typing_key_confirms,
        test_typing_hides_candidates,
        test_first_space_converts_to_first_candidate,
        test_space_cycles_candidates,
        test_arrow_navigation_across_pages,
        test_arrow_caret_and_segments,
        test_modifier_shortcuts_do_not_page,
        test_minus_equal_on_second_page,
        test_enter_commits_highlighted_candidate,
        test_punctuation_appends_unconfirmed,
        test_romanization_matches_declaration,
        test_nn_pair_consumption,
        test_longest_declared_suffix_preserves_raw_prefix,
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
