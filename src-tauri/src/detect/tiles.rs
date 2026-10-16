//! Full-width bands and seam reconciliation for tall pages.
// Ported from Komatose ocr/detect.py (_tiles, _clip, _iou_min, _dedupe), d9be51e.

use image::GrayImage;

use super::textblock::Quad;
use super::textdetector::TextBlockOut;

/// Ordinary pages bypass all tiling and reconciliation, preserving their output.
pub fn band_spans(width: u32, height: u32) -> Vec<(u32, u32)> {
    if width == 0 || u64::from(height) <= 2 * u64::from(width) {
        return Vec::new();
    }
    // A 3:2 band keeps a page-like aspect and ~683 model pixels across its width.
    let band = width.saturating_add(width / 2).max(1);
    let step = (band - band / 4).max(1);
    let mut spans = Vec::new();
    let mut y = 0u32;
    loop {
        let end = y.saturating_add(band).min(height);
        spans.push((y, end));
        if end == height {
            return spans;
        }
        y += step;
    }
}

pub struct Candidate {
    pub block: TextBlockOut,
    truncated: bool,
    /// Zero is the full-page context pass; bands start at one.
    source: usize,
}

impl Candidate {
    pub fn from_band(
        mut block: TextBlockOut,
        start: u32,
        end: u32,
        width: u32,
        height: u32,
        source: usize,
    ) -> Option<Self> {
        let local_height = (end - start) as i32;
        let truncated =
            (start > 0 && block.xyxy[1] < 6) || (end < height && block.xyxy[3] > local_height - 6);
        for point in block.lines.iter_mut().flatten() {
            point[0] = point[0].clamp(0, width as i32);
            point[1] = (point[1].clamp(0, local_height) + start as i32).min(height as i32);
        }
        block.xyxy[0] = block.xyxy[0].clamp(0, width as i32);
        block.xyxy[2] = block.xyxy[2].clamp(0, width as i32);
        block.xyxy[1] = block.xyxy[1].clamp(0, local_height) + start as i32;
        block.xyxy[3] = block.xyxy[3].clamp(0, local_height) + start as i32;
        let b = block.xyxy;
        if b[2] - b[0] < 6 || b[3] - b[1] < 6 {
            return None;
        }
        Some(Self {
            block,
            truncated,
            source,
        })
    }
}

fn area(b: [i32; 4]) -> f64 {
    f64::from((b[2] - b[0]).max(0)) * f64::from((b[3] - b[1]).max(0))
}

fn overlap(a: [i32; 4], b: [i32; 4]) -> (f64, f64, f64) {
    let ix = f64::from((a[2].min(b[2]) - a[0].max(b[0])).max(0));
    let iy = f64::from((a[3].min(b[3]) - a[1].max(b[1])).max(0));
    (
        ix * iy / area(a).min(area(b)).max(1.0),
        ix / f64::from((a[2] - a[0]).min(b[2] - b[0]).max(1)),
        iy / f64::from((a[3] - a[1]).min(b[3] - b[1]).max(1)),
    )
}

fn quad_box(q: &Quad) -> [i32; 4] {
    [
        q.iter().map(|p| p[0]).min().unwrap(),
        q.iter().map(|p| p[1]).min().unwrap(),
        q.iter().map(|p| p[0]).max().unwrap(),
        q.iter().map(|p| p[1]).max().unwrap(),
    ]
}

fn merge_lines(kept: &mut Vec<Quad>, incoming: Vec<Quad>) {
    for line in incoming {
        let a = quad_box(&line);
        if let Some(existing) = kept.iter_mut().find(|q| overlap(a, quad_box(q)).0 > 0.85) {
            // Prefer the fuller quad when overlap bands saw the same line twice.
            if area(a) > area(quad_box(existing)) {
                *existing = line;
            }
        } else {
            kept.push(line);
        }
    }
}

/// Prefer complete blocks, preserve small nested lettering, union aligned seam fragments.
pub fn dedupe(mut candidates: Vec<Candidate>) -> Vec<TextBlockOut> {
    // TextBlockOut has no detector score. At equal completeness, prefer the
    // higher-resolution bands to the full-page pass, retaining stable band order.
    candidates.sort_by_key(|c| (c.truncated, c.source == 0));
    let mut kept: Vec<Candidate> = Vec::new();
    'next: for candidate in candidates {
        for previous in &mut kept {
            let (a, b) = (candidate.block.xyxy, previous.block.xyxy);
            let (aa, ab) = (area(a), area(b));
            let (shared, ox, oy) = overlap(a, b);
            if candidate.truncated
                && previous.truncated
                && candidate.source != previous.source
                && shared > 0.25
                && (ox > 0.8 || oy > 0.8)
            {
                previous.block.xyxy = [
                    a[0].min(b[0]),
                    a[1].min(b[1]),
                    a[2].max(b[2]),
                    a[3].max(b[3]),
                ];
                merge_lines(&mut previous.block.lines, candidate.block.lines);
                continue 'next;
            }
            if (shared > 0.4 && aa.min(ab) / aa.max(ab) > 0.55)
                || (candidate.truncated && shared > 0.85 && aa < ab)
            {
                continue 'next;
            }
        }
        kept.push(candidate);
    }
    kept.sort_by_key(|c| (c.block.xyxy[1], c.block.xyxy[0]));
    kept.into_iter().map(|c| c.block).collect()
}

/// Combine overlapping detector probabilities without weakening existing evidence.
pub fn max_mask(page: &mut GrayImage, band: &GrayImage, start: u32) {
    assert_eq!(page.width(), band.width());
    assert!(u64::from(start) + u64::from(band.height()) <= u64::from(page.height()));
    let offset = start as usize * page.width() as usize;
    for (dst, src) in page.as_mut()[offset..].iter_mut().zip(band.as_raw()) {
        *dst = (*dst).max(*src);
    }
}

#[cfg(test)]
mod tests {
    use super::super::textblock::Language;
    use super::*;

    fn candidate(b: [i32; 4], truncated: bool, source: usize) -> Candidate {
        Candidate {
            block: TextBlockOut {
                xyxy: b,
                lines: vec![[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]],
                vertical: true,
                font_size: 20.0,
                angle: 0,
                language: Language::Ja,
            },
            truncated,
            source,
        }
    }

    #[test]
    fn bands_only_run_above_two_to_one_and_cover_the_tail() {
        for (w, h) in [(0, 100), (100, 0), (100, 200), (200, 100), (1080, 1535)] {
            assert!(band_spans(w, h).is_empty());
        }
        assert_eq!(band_spans(100, 201), [(0, 150), (113, 201)]);
        assert_eq!(
            band_spans(100, 500),
            [(0, 150), (113, 263), (226, 376), (339, 489), (452, 500)]
        );
        assert_eq!(band_spans(1, 3), [(0, 1), (1, 2), (2, 3)]);
        for width in [2, 7, 100, 720] {
            let height = width * 13;
            let spans = band_spans(width, height);
            assert_eq!(spans.first().unwrap().0, 0);
            assert_eq!(spans.last().unwrap().1, height);
            assert!(spans
                .windows(2)
                .all(|s| s[1].0 <= s[0].1 && s[1].1 > s[0].1));
        }
    }

    #[test]
    fn mapping_moves_boxes_and_quads_and_marks_only_inner_edges() {
        let mapped = Candidate::from_band(
            candidate([-2, 1, 40, 99], false, 0).block,
            100,
            200,
            100,
            400,
            2,
        )
        .unwrap();
        assert_eq!(mapped.block.xyxy, [0, 101, 40, 199]);
        assert_eq!(mapped.block.lines[0][0], [0, 101]);
        assert_eq!(mapped.block.font_size, 20.0);
        assert!(mapped.truncated);
        assert!(
            !Candidate::from_band(
                candidate([0, 0, 40, 100], false, 0).block,
                0,
                100,
                100,
                100,
                0
            )
            .unwrap()
            .truncated
        );
        assert!(Candidate::from_band(
            candidate([0, 0, 5, 100], false, 0).block,
            0,
            100,
            100,
            100,
            0
        )
        .is_none());
    }

    #[test]
    fn complete_blocks_swallow_fragments_but_keep_small_complete_nested_text() {
        let out = dedupe(vec![
            candidate([10, 10, 110, 110], false, 0),
            candidate([11, 11, 109, 109], false, 1),
            candidate([20, 20, 40, 40], true, 2),
            candidate([50, 50, 70, 70], false, 3),
        ]);
        assert_eq!(
            out.iter().map(|b| b.xyxy).collect::<Vec<_>>(),
            [[11, 11, 109, 109], [50, 50, 70, 70]]
        );
    }

    #[test]
    fn seam_union_requires_alignment_and_different_bands() {
        let out = dedupe(vec![
            candidate([10, 50, 50, 150], true, 1),
            candidate([10, 120, 50, 220], true, 2),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].xyxy, [10, 50, 50, 220]);
        assert_eq!(out[0].lines.len(), 2);
        assert_eq!(
            dedupe(vec![
                candidate([10, 50, 50, 150], true, 1),
                candidate([10, 120, 50, 220], true, 1)
            ])
            .len(),
            2
        );
        assert_eq!(
            dedupe(vec![
                candidate([0, 0, 100, 100], true, 1),
                candidate([40, 40, 140, 140], true, 2)
            ])
            .len(),
            2
        );
    }

    #[test]
    fn masks_take_the_max_at_page_offsets() {
        let mut page = GrayImage::from_raw(2, 3, vec![1, 2, 200, 4, 5, 6]).unwrap();
        let band = GrayImage::from_raw(2, 2, vec![10, 20, 30, 40]).unwrap();
        max_mask(&mut page, &band, 1);
        assert_eq!(page.as_raw(), &[1, 2, 200, 20, 30, 40]);
    }
}
