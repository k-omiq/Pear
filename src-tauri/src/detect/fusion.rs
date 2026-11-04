//! Cross-check CTD and RT-DETR while keeping RT-DETR's lettering classes.
// Ported from Komatose src/lib/server/detectFusion.ts, commit d9be51e (two sources).

use super::rtdetr::{Class, Region};
use super::textblock::{round_half_even, Language};
use super::textdetector::TextBlockOut;

const CTD_ALONE: f32 = 0.6;
const BUBBLE_ALONE: f32 = 0.5;
const FREE_ALONE: f32 = 0.6;
const SAME_IOU: f64 = 0.4;
const SAME_ANY_CLASS_IOU: f64 = 0.6;
const FRAGMENT_INSIDE: f64 = 0.8;
const LOOSE_RATIO: f64 = 0.3;
const VOTE_INSIDE: f64 = 0.6;
const VOTE_RATIO: f64 = 0.15;
const CONTAINER_HOLDS: usize = 2;
const BUBBLE_KEEP: f32 = 0.4;
const IN_BUBBLE: f64 = 0.8;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    RtDetr,
    Ctd,
}

struct Candidate {
    block: TextBlockOut,
    bbox: [f64; 4],
    source: Source,
}

fn area(b: [f64; 4]) -> f64 {
    (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0)
}

fn intersection(a: [f64; 4], b: [f64; 4]) -> f64 {
    (a[2].min(b[2]) - a[0].max(b[0])).max(0.0) * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0)
}

fn iou(a: [f64; 4], b: [f64; 4]) -> f64 {
    let i = intersection(a, b);
    let union = area(a) + area(b) - i;
    if union > 0.0 {
        i / union
    } else {
        0.0
    }
}

fn inside(inner: [f64; 4], outer: [f64; 4]) -> f64 {
    let a = area(inner);
    if a > 0.0 {
        intersection(inner, outer) / a
    } else {
        0.0
    }
}

fn ratio(a: [f64; 4], b: [f64; 4]) -> f64 {
    let large = area(a).max(area(b));
    if large > 0.0 {
        area(a).min(area(b)) / large
    } else {
        0.0
    }
}

fn compatible(a: &Candidate, b: &Candidate) -> bool {
    a.block.kind == b.block.kind || a.block.kind.is_none() || b.block.kind.is_none()
}

fn repeats(c: &Candidate, seed: &Candidate) -> bool {
    let shared = iou(c.bbox, seed.bbox);
    if shared >= SAME_ANY_CLASS_IOU {
        return true;
    }
    if !compatible(c, seed) {
        return false;
    }
    if shared >= SAME_IOU {
        return true;
    }
    if area(c.bbox) < area(seed.bbox) {
        inside(c.bbox, seed.bbox) >= FRAGMENT_INSIDE
    } else {
        inside(seed.bbox, c.bbox) >= FRAGMENT_INSIDE && ratio(c.bbox, seed.bbox) >= LOOSE_RATIO
    }
}

fn second_opinion(a: &Candidate, b: &Candidate) -> bool {
    if a.source == b.source {
        return false;
    }
    let shared = iou(a.bbox, b.bbox);
    shared >= SAME_ANY_CLASS_IOU
        || (compatible(a, b)
            && (shared >= SAME_IOU
                || (ratio(a.bbox, b.bbox) >= VOTE_RATIO
                    && inside(a.bbox, b.bbox).max(inside(b.bbox, a.bbox)) >= VOTE_INSIDE)))
}

fn stands_alone(c: &Candidate) -> bool {
    c.block.score
        >= match c.source {
            Source::Ctd => CTD_ALONE,
            Source::RtDetr if c.block.kind.as_deref() == Some("free") => FREE_ALONE,
            Source::RtDetr => BUBBLE_ALONE,
        }
}

fn region_block(region: &Region, lang: &str) -> TextBlockOut {
    let [x1, y1, x2, y2] = region.bbox.map(|v| round_half_even(f64::from(v)) as i32);
    let vertical = y2 - y1 > x2 - x1;
    // For one axis-aligned line, textblock::examine_textblk measures exactly
    // this perpendicular side: width for vertical text, height for horizontal.
    let font_size = if vertical { x2 - x1 } else { y2 - y1 }.max(1) as f64;
    TextBlockOut {
        xyxy: [x1, y1, x2, y2],
        lines: vec![[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]],
        vertical,
        font_size,
        angle: 0,
        language: if lang == "ja" {
            Language::Ja
        } else {
            Language::Unknown
        },
        score: region.score,
        kind: region.class.kind().map(str::to_string),
    }
}

/// Called only after both detectors ran successfully, including an empty RT-DETR result.
pub fn fuse(ctd: Vec<TextBlockOut>, rtdetr: Vec<Region>, lang: &str) -> Vec<TextBlockOut> {
    let mut candidates: Vec<_> = rtdetr
        .iter()
        .filter(|r| r.class.kind().is_some())
        .map(|region| Candidate {
            block: region_block(region, lang),
            bbox: region.bbox.map(f64::from),
            source: Source::RtDetr,
        })
        .collect();
    candidates.extend(ctd.into_iter().map(|block| Candidate {
        bbox: block.xyxy.map(f64::from),
        block,
        source: Source::Ctd,
    }));
    let mut backed: Vec<_> = candidates
        .iter()
        .filter(|c| stands_alone(c) || candidates.iter().any(|d| second_opinion(c, d)))
        .collect();
    backed.sort_by(|a, b| {
        (a.source == Source::Ctd)
            .cmp(&(b.source == Source::Ctd))
            .then_with(|| b.block.score.total_cmp(&a.block.score))
    });

    // Compare with seed geometry only; a broad member cannot chain two bubbles.
    let mut seeds: Vec<Vec<&Candidate>> = Vec::new();
    for c in backed {
        if c.source == Source::Ctd
            && seeds
                .iter()
                .filter(|s| {
                    inside(s[0].bbox, c.bbox) >= VOTE_INSIDE && area(s[0].bbox) < area(c.bbox) * 0.7
                })
                .count()
                >= CONTAINER_HOLDS
        {
            continue;
        }
        let mut home: Option<usize> = None;
        for (i, seed) in seeds.iter().enumerate() {
            if !repeats(c, seed[0]) {
                continue;
            }
            if home.is_none_or(|best| {
                let (current, previous) =
                    (iou(c.bbox, seed[0].bbox), iou(c.bbox, seeds[best][0].bbox));
                current > previous
                    || (current == previous && area(seed[0].bbox) < area(seeds[best][0].bbox))
            }) {
                home = Some(i);
            }
        }
        if let Some(i) = home {
            seeds[i].push(c);
        } else {
            seeds.push(vec![c]);
        }
    }

    seeds
        .into_iter()
        .map(|members| {
            let lead = members[0];
            // RT-DETR supplies geometry/classes; agreeing CTD lines retain measured glyph size.
            let measured = members
                .iter()
                .filter(|c| c.source == Source::Ctd)
                .max_by(|a, b| iou(a.bbox, lead.bbox).total_cmp(&iou(b.bbox, lead.bbox)));
            let mut block = measured.map_or_else(|| lead.block.clone(), |c| c.block.clone());
            block.xyxy = lead.bbox.map(|v| round_half_even(v) as i32);
            block.kind = members
                .iter()
                .find(|c| c.source == Source::RtDetr)
                .and_then(|c| c.block.kind.clone());
            block.score = members.iter().map(|c| c.block.score).fold(0.0, f32::max);
            block
        })
        .collect()
}

/// RT-DETR's bubble boxes worth keeping, as page rectangles. Placement reads
/// them; they are never text blocks.
pub fn bubbles(regions: &[Region]) -> Vec<[i32; 4]> {
    regions
        .iter()
        .filter(|r| r.class == Class::Bubble && r.score >= BUBBLE_KEEP)
        .map(|r| r.bbox.map(|v| round_half_even(f64::from(v)) as i32))
        .filter(|b| b[2] > b[0] && b[3] > b[1])
        .collect()
}

/// Says which side of a bubble's wall each block is on, from the bubble boxes.
/// A block mostly inside a bubble is "bubble" whatever RT-DETR's text class
/// said (its free text calls are the less certain); one outside every bubble
/// keeps RT-DETR's word, or none. With no bubbles nothing changes: no box is
/// no evidence that a block is on the art.
pub fn mark_in_bubble(blocks: &mut [TextBlockOut], bubbles: &[[i32; 4]]) {
    for block in blocks {
        let b = block.xyxy.map(f64::from);
        if bubbles.iter().any(|&o| inside(b, o.map(f64::from)) >= IN_BUBBLE) {
            block.kind = Some("bubble".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctd(b: [i32; 4], score: f32) -> TextBlockOut {
        TextBlockOut {
            xyxy: b,
            score,
            font_size: 18.0,
            lines: vec![[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]],
            ..Default::default()
        }
    }

    fn rt(b: [f32; 4], score: f32, class: Class) -> Region {
        Region::new(b, score, class)
    }

    #[test]
    fn lone_proposals_need_their_source_and_class_thresholds() {
        assert!(fuse(vec![ctd([0, 0, 100, 100], 0.599)], vec![], "ja").is_empty());
        assert_eq!(
            fuse(vec![ctd([0, 0, 100, 100], 0.6)], vec![], "ja").len(),
            1
        );
        for (class, score, keep) in [
            (Class::TextBubble, 0.499, false),
            (Class::TextBubble, 0.5, true),
            (Class::TextFree, 0.599, false),
            (Class::TextFree, 0.6, true),
        ] {
            assert_eq!(
                !fuse(
                    vec![],
                    vec![rt([0.0, 0.0, 100.0, 100.0], score, class)],
                    "ja"
                )
                .is_empty(),
                keep
            );
        }
    }

    #[test]
    fn two_weak_detectors_corroborate_and_preserve_measured_ctd_lines() {
        let measured = ctd([10, 10, 90, 90], 0.41);
        let out = fuse(
            vec![measured.clone()],
            vec![rt([5.0, 5.0, 95.0, 95.0], 0.21, Class::TextBubble)],
            "ja",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].xyxy, [5, 5, 95, 95]);
        assert_eq!(out[0].kind.as_deref(), Some("bubble"));
        assert_eq!(out[0].font_size, measured.font_size);
        assert_eq!(out[0].lines, measured.lines);
        assert_eq!(out[0].score, 0.41);
    }

    #[test]
    fn same_source_duplicates_are_not_a_second_opinion() {
        assert!(fuse(
            vec![ctd([0, 0, 100, 100], 0.5), ctd([0, 0, 100, 100], 0.5)],
            vec![],
            "ja"
        )
        .is_empty());
        assert!(fuse(
            vec![],
            vec![
                rt([0.0, 0.0, 100.0, 100.0], 0.3, Class::TextBubble),
                rt([0.0, 0.0, 100.0, 100.0], 0.3, Class::TextBubble)
            ],
            "ja"
        )
        .is_empty());
    }

    #[test]
    fn ctd_container_is_dropped_before_it_can_repeat_one_of_two_seeds() {
        let out = fuse(
            vec![ctd([0, 0, 200, 100], 0.9)],
            vec![
                rt([0.0, 0.0, 130.0, 100.0], 0.4, Class::TextBubble),
                rt([140.0, 0.0, 190.0, 100.0], 0.4, Class::TextBubble),
            ],
            "ja",
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].xyxy, [0, 0, 130, 100]);
        assert_eq!(out[1].xyxy, [140, 0, 190, 100]);
        assert!(out.iter().all(|b| b.kind.as_deref() == Some("bubble")));
    }

    #[test]
    fn nested_free_lettering_is_distinct_but_high_iou_cross_class_duplicates_collapse() {
        let outer = rt([0.0, 0.0, 100.0, 100.0], 0.9, Class::TextBubble);
        assert_eq!(
            fuse(
                vec![],
                vec![
                    outer.clone(),
                    rt([20.0, 20.0, 80.0, 80.0], 0.8, Class::TextFree)
                ],
                "ja"
            )
            .len(),
            2
        );
        let out = fuse(
            vec![],
            vec![outer, rt([0.0, 0.0, 100.0, 100.0], 0.8, Class::TextFree)],
            "ja",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind.as_deref(), Some("bubble"));
    }

    #[test]
    fn rtdetr_only_text_uses_one_quad_and_the_perpendicular_side_as_font_size() {
        let out = fuse(
            vec![],
            vec![rt([10.0, 20.0, 40.0, 100.0], 0.7, Class::TextFree)],
            "ko",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].lines,
            vec![[[10, 20], [40, 20], [40, 100], [10, 100]]]
        );
        assert!(out[0].vertical);
        assert_eq!(out[0].font_size, 30.0);
        assert_eq!(out[0].language, Language::Unknown);
        assert_eq!(out[0].kind.as_deref(), Some("free"));
    }

    #[test]
    fn plain_bubbles_are_not_text_or_corroborating_lettering_votes() {
        let out = fuse(
            vec![ctd([0, 0, 100, 100], 0.5)],
            vec![rt([0.0, 0.0, 100.0, 100.0], 0.99, Class::Bubble)],
            "ja",
        );
        assert!(out.is_empty());
    }

    #[test]
    fn keeps_confident_bubble_boxes_only() {
        let got = bubbles(&[
            rt([10.4, 20.0, 200.0, 150.6], 0.9, Class::Bubble),
            rt([0.0, 0.0, 50.0, 50.0], 0.2, Class::Bubble),
            rt([30.0, 40.0, 60.0, 90.0], 0.9, Class::TextBubble),
        ]);
        assert_eq!(got, vec![[10, 20, 200, 151]]);
    }

    #[test]
    fn a_block_inside_a_bubble_is_bubble_text_and_one_outside_keeps_its_kind() {
        let mut free_in = ctd([20, 20, 60, 60], 0.9);
        free_in.kind = Some("free".into());
        let mut free_out = ctd([300, 300, 340, 340], 0.9);
        free_out.kind = Some("free".into());
        let mut blocks = vec![free_in, free_out, ctd([400, 0, 440, 40], 0.9), ctd([90, 90, 150, 150], 0.9)];
        mark_in_bubble(&mut blocks, &[[0, 0, 100, 100]]);
        let kinds: Vec<_> = blocks.iter().map(|b| b.kind.as_deref()).collect();
        assert_eq!(kinds, vec![Some("bubble"), Some("free"), None, None]);
    }
}
