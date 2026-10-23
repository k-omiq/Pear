//! Auto pick: which sound type suits a sound, from how it is spelt.
//!
//! A fixed rule table, no model. Japanese kana are read for the features a
//! letterer reads: voiced consonants (ガ ザ ダ バ) are heavy, the p-row is
//! light and bouncy, a closing ッ is sharp and short, a closing ン rings on,
//! ー drags, repeats rumble. Latin text is looked up in a short word list.
//! Every type gets a score; the caller shows the best few.

use super::kinds::KINDS;

/// Consonant row and vowel of a katakana letter (hiragana are folded to
/// katakana first). `None` for a letter that is neither.
fn row_vowel(c: char) -> Option<(char, char)> {
    const ROWS: &[(&str, char)] = &[
        ("アイウエオァィゥェォ", '-'),
        ("カキクケコ", 'k'),
        ("ガギグゲゴ", 'g'),
        ("サシスセソ", 's'),
        ("ザジズゼゾ", 'z'),
        ("タチツテト", 't'),
        ("ダヂヅデド", 'd'),
        ("ナニヌネノ", 'n'),
        ("ハヒフヘホ", 'h'),
        ("バビブベボ", 'b'),
        ("パピプペポ", 'p'),
        ("マミムメモ", 'm'),
        ("ヤユヨャュョ", 'y'),
        ("ラリルレロ", 'r'),
        ("ワヲ", 'w'),
        ("ヴ", 'v'),
    ];
    const VOWELS: &[(&str, char)] = &[
        ("アカガサザタダナハバパマヤラワァャ", 'a'),
        ("イキギシジチヂニヒビピミリィ", 'i'),
        ("ウクグスズツヅヌフブプムユルゥュヴ", 'u'),
        ("エケゲセゼテデネヘベペメレェ", 'e'),
        ("オコゴソゾトドノホボポモヨロヲォョ", 'o'),
    ];
    let row = ROWS.iter().find(|(s, _)| s.contains(c))?.1;
    let vowel = VOWELS
        .iter()
        .find(|(s, _)| s.contains(c))
        .map_or('u', |v| v.1);
    Some((row, vowel))
}

fn to_katakana(c: char) -> char {
    match c {
        'ぁ'..='ゖ' => char::from_u32(c as u32 + 0x60).unwrap_or(c),
        _ => c,
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Features {
    kana: usize,
    hiragana_share: f64,
    voiced: f64,
    p_row: f64,
    ends_tsu: bool,
    ends_n: bool,
    long: bool,
    repeats: bool,
    first: char,
    /// Shares of the vowels a, i, and o or u.
    a: f64,
    i: f64,
    ou: f64,
    bangs: usize,
    core: String,
}

fn features(text: &str) -> Features {
    let plain: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '/')
        .collect();
    let kata: String = plain.chars().map(to_katakana).collect();
    let hira = plain.chars().filter(|c| matches!(c, 'ぁ'..='ゖ')).count();
    let all_kana = plain
        .chars()
        .filter(|c| matches!(c, 'ぁ'..='ゖ' | 'ァ'..='ヺ'))
        .count();
    let letters: Vec<(char, Option<(char, char)>)> = kata
        .chars()
        .filter(|&c| row_vowel(c).is_some() || matches!(c, 'ッ' | 'ン' | 'ー'))
        .map(|c| (c, row_vowel(c)))
        .collect();
    let n = letters.len().max(1) as f64;
    let share = |f: &dyn Fn(char, char) -> bool| {
        letters
            .iter()
            .filter(|(_, rv)| rv.is_some_and(|(r, v)| f(r, v)))
            .count() as f64
            / n
    };
    let core: String = kata
        .trim_end_matches(|c: char| "!?！？…‥・。、".contains(c))
        .to_string();
    // Kana only: a stretched Latin spelling ("BOOM") is not a repeat.
    let squeezed: Vec<char> = letters
        .iter()
        .map(|l| l.0)
        .filter(|c| !matches!(c, 'ッ' | 'ー'))
        .collect();
    // A unit of one or two letters said at least twice in a row.
    let repeats = (1..=2).any(|w| {
        squeezed.len() >= 2 * w
            && (0..=squeezed.len() - 2 * w)
                .any(|s| squeezed[s..s + w] == squeezed[s + w..s + 2 * w])
    });
    Features {
        kana: letters.len(),
        hiragana_share: if all_kana > 0 {
            hira as f64 / all_kana as f64
        } else {
            0.0
        },
        voiced: share(&|r, _| matches!(r, 'g' | 'z' | 'd' | 'b' | 'v')),
        p_row: share(&|r, _| r == 'p'),
        ends_tsu: core.ends_with('ッ'),
        ends_n: core.ends_with('ン'),
        long: kata.contains(['ー', '〜', '~']),
        repeats,
        first: letters
            .iter()
            .find_map(|(_, rv)| rv.map(|(r, _)| r))
            .unwrap_or(' '),
        a: share(&|_, v| v == 'a'),
        i: share(&|_, v| v == 'i'),
        ou: share(&|_, v| v == 'o' || v == 'u'),
        bangs: plain.chars().filter(|c| matches!(c, '!' | '！')).count(),
        core,
    }
}

/// Latin sounds, by word, to a type.
const WORDS: &[(&str, &str)] = &[
    ("boom", "impact"),
    ("bam", "impact"),
    ("wham", "impact"),
    ("pow", "impact"),
    ("thud", "impact"),
    ("bang", "impact"),
    ("thump", "impact"),
    ("crash", "explosion"),
    ("smash", "explosion"),
    ("krak", "explosion"),
    ("crack", "explosion"),
    ("kaboom", "explosion"),
    ("blam", "explosion"),
    ("whoosh", "slash"),
    ("swoosh", "slash"),
    ("zoom", "slash"),
    ("slash", "slash"),
    ("shing", "slash"),
    ("swish", "slash"),
    ("rumble", "rumble"),
    ("grr", "rumble"),
    ("doom", "rumble"),
    ("splash", "splash"),
    ("sploosh", "splash"),
    ("drip", "drip"),
    ("plop", "drip"),
    ("plip", "drip"),
    ("sparkle", "soft"),
    ("twinkle", "soft"),
    ("boing", "pop"),
    ("pop", "pop"),
    ("ta-da", "pop"),
    ("knock", "small"),
    ("click", "small"),
    ("tap", "small"),
    ("beep", "small"),
    ("creak", "small"),
    ("gasp", "shock"),
    ("gulp", "shock"),
    ("silence", "silence"),
    ("glare", "glare"),
    ("stare", "glare"),
];

fn latin_kind(text: &str) -> Option<&'static str> {
    let word: String = text
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .flat_map(char::to_lowercase)
        .collect();
    if word.is_empty() {
        return None;
    }
    // Exact, then a stretched spelling ("BOOOOM", "CRAAASH"): the word with
    // runs of a repeated letter squeezed to one or two.
    let squeeze = |w: &str, keep: usize| {
        let mut out = String::new();
        let mut run = 0;
        let mut prev = None;
        for c in w.chars() {
            run = if Some(c) == prev { run + 1 } else { 1 };
            prev = Some(c);
            if run <= keep {
                out.push(c);
            }
        }
        out
    };
    WORDS
        .iter()
        .find(|(w, _)| *w == word || *w == squeeze(&word, 1) || *w == squeeze(&word, 2))
        .map(|(_, k)| *k)
}

/// The answer: every type's score and the three macros the sound asks for.
#[derive(Clone, Debug, PartialEq)]
pub struct Pick {
    /// Indices into [`KINDS`], best first. Ties keep the table's order.
    pub order: Vec<usize>,
    /// Scores in [`KINDS`] order.
    pub scores: Vec<f64>,
    /// 0..100 each, 50 the type as designed (`params::macros`): how hard,
    /// how rough and how driven the sound reads. See [`macros_for`].
    pub power: f64,
    pub rough: f64,
    pub momentum: f64,
}

/// The macros a sound asks for, from three things about how it is spelt:
/// its share of voiced kana (`v`, ド against ト: heavier and harsher), its
/// bangs (`b`, 0..2: louder and thrown harder) and its share of hiragana
/// (`h`: softer, smoother, slower). Each macro is 50 moved by up to half its
/// range, whole numbers:
///
/// - power    50 + 50 (0.6 v + 0.12 b - 0.25 h), the old strength's weights
///   (strength 1 + that sum), so a sound reads as heavy as it did;
/// - rough    50 + 50 (0.6 v - 0.4 h): voiced sounds are gritty, hiragana
///   smooth; bangs are loud, not rough;
/// - momentum 50 + 50 (0.25 b + 0.3 v - 0.25 h): bangs throw the run
///   forward, a voiced sound pushes, hiragana drifts.
fn macros_for(voiced: f64, bangs: f64, hiragana: f64) -> (f64, f64, f64) {
    let m = |sum: f64| (50.0 + 50.0 * sum).clamp(0.0, 100.0).round();
    (
        m(0.6 * voiced + 0.12 * bangs - 0.25 * hiragana),
        m(0.6 * voiced - 0.4 * hiragana),
        m(0.25 * bangs + 0.3 * voiced - 0.25 * hiragana),
    )
}

pub fn pick(text: &str) -> Pick {
    let f = features(text);
    let row = |rows: &str| f.first != ' ' && rows.contains(f.first);
    let hard = row("ktgdbp");
    let hiss = row("szh");
    let soft_row = row("hmnry");
    let b = |v: bool| if v { 1.0 } else { 0.0 };
    let has = |s: &str| f.core.contains(|c: char| s.contains(c));
    // Letter pairs a type is known by: ドボ splashes, ポタ drips.
    let seq = |all: &[&str]| b(all.iter().any(|s| f.core.contains(s)));
    let bangs = f.bangs.min(2) as f64;
    let short = f.kana > 0 && f.kana <= 3;
    let mut scores = vec![0.0; KINDS.len()];
    let mut set = |id: &str, v: f64| {
        if let Some(i) = KINDS.iter().position(|k| k.id == id) {
            scores[i] = v;
        }
    };
    set(
        "impact",
        1.8 * f.voiced
            + 0.5 * b(f.ends_n)
            + 0.4 * bangs
            + 0.4 * b(hard)
            + 0.3 * f.ou
            + 0.3 * b(short)
            + 0.2 * (1.0 - f.hiragana_share),
    );
    set(
        "rumble",
        1.7 * b(f.repeats) + 1.0 * f.voiced + 0.5 * f.ou - 0.4 * b(f.ends_tsu),
    );
    set(
        "slash",
        1.2 * b(hiss)
            + 0.9 * b(f.ends_tsu)
            + 0.3 * b(has("ュャョ"))
            + 0.2 * f.a
            + 0.2 * (1.0 - f.hiragana_share),
    );
    set(
        "explosion",
        1.0 * seq(&[
            "バキ",
            "ドカ",
            "ドガ",
            "ガシャ",
            "バリ",
            "ボカ",
            "ズガ",
            "バゴ",
            "グシャ",
        ]) + 1.0 * f.voiced
            + 0.2 * b(hard)
            + 0.6 * b(f.ends_tsu)
            + 0.3 * f.i
            + 0.2 * b(has("ガギグゴ")),
    );
    set(
        "splash",
        1.2 * seq(&[
            "ドボ",
            "ザブ",
            "ザバ",
            "バシャ",
            "ジャブ",
            "ジャボ",
            "ザッパ",
            "ドプ",
        ]) + 0.3 * b(has("ザバドボブ"))
            + 0.4 * b(f.long)
            + 0.3 * b(f.ends_n)
            + 0.4 * f.voiced,
    );
    set(
        "soft",
        1.0 * f.hiragana_share
            + 0.8 * f.p_row
            + 0.6 * f.i
            + 0.3 * b(f.ends_tsu)
            + 0.3 * b(soft_row),
    );
    set(
        "drip",
        1.2 * seq(&[
            "ポタ",
            "ピチャ",
            "ポチャ",
            "チャポ",
            "ピチョ",
            "ポト",
            "ピト",
            "チャプ",
        ]) + 0.8 * f.hiragana_share
            + 0.6 * f.p_row
            + 0.4 * b(f.ends_n)
            + 0.3 * b(has("チャポピプ")),
    );
    set(
        "small",
        0.8 * b(short) + 0.3 * b(f.ends_n) + 0.4 * b(has("ストコカ")) - 0.6 * f.voiced,
    );
    set(
        "glare",
        1.8 * seq(&["ギロ", "ジロ", "ギン", "ギラ", "ギョロ", "ジー"])
            + 0.4 * b(has("ギジ"))
            + 0.3 * b(f.ends_tsu),
    );
    set(
        "pop",
        0.6 * f.p_row + 0.5 * b(f.long) + 0.35 * bangs + 0.3 * b(has("バドジャ")),
    );
    set(
        "silence",
        1.4 * b(f.core.starts_with('シ') && !f.core.contains(|c: char| "ャュョッ".contains(c)))
            + 0.5 * b(f.long)
            + 0.5 * b(f.ends_n)
            - 0.8 * f.voiced,
    );
    set(
        "shock",
        0.6 * b(has("ガズ")) + 0.6 * b(f.long) + 0.5 * b(f.ends_n) + 0.5 * f.voiced,
    );
    if let Some(id) = latin_kind(text) {
        set(id, 3.0);
    }
    let mut order: Vec<usize> = (0..KINDS.len()).collect();
    order.sort_by(|&x, &y| scores[y].total_cmp(&scores[x]));
    let (power, rough, momentum) = macros_for(f.voiced, bangs, f.hiragana_share);
    Pick {
        order,
        scores,
        power,
        rough,
        momentum,
    }
}

/// The pick as one ASCII JSON document:
/// `{"order":["impact",...],"scores":[...],"power":62,"rough":58,"momentum":55}`.
pub fn pick_json(p: &Pick) -> String {
    let mut out = String::from("{\"order\":[");
    for (n, &i) in p.order.iter().enumerate() {
        if n > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(KINDS[i].id);
        out.push('"');
    }
    out.push_str("],\"scores\":[");
    for (n, s) in p.scores.iter().enumerate() {
        if n > 0 {
            out.push(',');
        }
        // Two decimals: a score is a ranking, not a measurement.
        out.push_str(&((s * 100.0).round() / 100.0).to_string());
    }
    out.push(']');
    for (name, v) in [
        ("power", p.power),
        ("rough", p.rough),
        ("momentum", p.momentum),
    ] {
        out.push_str(",\"");
        out.push_str(name);
        out.push_str("\":");
        out.push_str(&v.to_string());
    }
    out.push('}');
    out
}
