//! An SFX text cut into groups and items.
//!
//! A group is one line of the text, or one side of a `/` (`ギ/ロッ` is two
//! groups): each group runs along a path of its own. An item is what takes
//! one place on that path: a letter with its marks, a space, a run of long
//! vowel bars (`ーーー` drawn as one stretched bar), or a run of up to three
//! `!` and `?` set in one cell.

use crate::engine::extends_cluster;

/// More groups than this are folded into the last one.
pub const MAX_GROUPS: usize = 4;
/// Most items in one text. Past it the text is refused.
pub const MAX_ITEMS: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Letter,
    Space,
    /// `n` long vowel bars drawn as one.
    Bar(u32),
    /// A run of `!` and `?`, this many.
    Punct(u32),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub kind: ItemKind,
    /// The text the item draws, in bytes of the input. A bar run draws its
    /// first bar only, stretched.
    pub bytes: core::ops::Range<usize>,
    /// The same, in UTF-16 units, which is what JS slices by.
    pub utf16: core::ops::Range<u32>,
}

impl Item {
    pub fn text<'a>(&self, all: &'a str) -> &'a str {
        &all[self.bytes.clone()]
    }

    /// Whether the item turns a quarter in vertical text: the long bar and
    /// the dashes and dots that run along the line.
    pub fn turns_upright(&self, all: &str) -> bool {
        matches!(self.kind, ItemKind::Bar(_))
            || matches!(
                self.text(all),
                "ー" | "〜" | "～" | "…" | "‥" | "—" | "―" | "－" | "-" | "~"
            )
    }

    /// Whether the item is a small kana, which vertical text sets high and to
    /// the right in its cell.
    pub fn is_small_kana(&self, all: &str) -> bool {
        self.kind == ItemKind::Letter
            && "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ".contains(self.text(all))
            && self.text(all).chars().count() == 1
    }
}

const BAR: char = 'ー';

fn is_space(c: char) -> bool {
    c == ' ' || c == '\u{3000}' || c == '\t'
}

fn is_punct(c: char) -> bool {
    matches!(c, '!' | '?' | '！' | '？' | '‼' | '⁉' | '⁈')
}

/// The groups of `text`, each a list of items. Empty groups (blank lines,
/// `//`) are dropped; spaces at a group's ends are trimmed. With
/// `join_bars`, two or more bars in a row are one [`ItemKind::Bar`].
///
/// `None` when the text has more than [`MAX_ITEMS`] items.
pub fn groups(text: &str, join_bars: bool) -> Option<Vec<Vec<Item>>> {
    // Each character with its byte and UTF-16 offset; the end as a sentinel.
    let mut at: Vec<(usize, u32, char)> = Vec::new();
    let mut u = 0u32;
    for (b, c) in text.char_indices() {
        at.push((b, u, c));
        u += c.len_utf16() as u32;
    }
    let end = (text.len(), u);
    let off = |k: usize| at.get(k).map_or(end, |&(b, u, _)| (b, u));

    let mut out: Vec<Vec<Item>> = Vec::new();
    let mut cur: Vec<Item> = Vec::new();
    let mut count = 0usize;
    let flush = |cur: &mut Vec<Item>, out: &mut Vec<Vec<Item>>| {
        while cur.last().is_some_and(|i| i.kind == ItemKind::Space) {
            cur.pop();
        }
        if !cur.is_empty() {
            out.push(core::mem::take(cur));
        }
    };
    let mut k = 0;
    while k < at.len() {
        let c = at[k].2;
        if c == '\n' || c == '\r' || c == '/' {
            flush(&mut cur, &mut out);
            k += 1;
            continue;
        }
        let start = k;
        let kind = if is_space(c) {
            k += 1;
            if cur.is_empty() {
                continue;
            }
            ItemKind::Space
        } else if c == BAR && join_bars && at.get(k + 1).is_some_and(|n| n.2 == BAR) {
            let mut n = 0;
            while at.get(k).is_some_and(|x| x.2 == BAR) {
                n += 1;
                k += 1;
            }
            ItemKind::Bar(n)
        } else if is_punct(c) {
            let mut n = 0;
            while n < 3 && at.get(k).is_some_and(|x| is_punct(x.2)) {
                n += 1;
                k += 1;
            }
            ItemKind::Punct(n)
        } else {
            k += 1;
            while at.get(k).is_some_and(|x| extends_cluster(x.2)) {
                k += 1;
            }
            ItemKind::Letter
        };
        // A bar run draws one bar; everything else draws what it covers.
        let draw_end = if matches!(kind, ItemKind::Bar(_)) {
            start + 1
        } else {
            k
        };
        let (b0, u0) = off(start);
        let (b1, u1) = off(draw_end);
        count += 1;
        if count > MAX_ITEMS {
            return None;
        }
        cur.push(Item {
            kind,
            bytes: b0..b1,
            utf16: u0..u1,
        });
    }
    flush(&mut cur, &mut out);
    if out.len() > MAX_GROUPS {
        let rest: Vec<Item> = out.drain(MAX_GROUPS..).flatten().collect();
        if let Some(last) = out.last_mut() {
            last.extend(rest);
        }
    }
    Some(out)
}
