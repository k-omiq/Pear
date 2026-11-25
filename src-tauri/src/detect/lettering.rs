//! Region-constrained lettering masks for cleaning and mask knock-out.
// Ported from Komatose ocr/lettering.py (refine), commit d9be51e.

use image::GrayImage;

use super::crops::Raster;
use super::cvops::{fill_poly, find_contours};

const STRONG: u8 = 150;
const WEAK: u8 = 65;

struct Component {
    pixels: Vec<usize>,
    bounds: [usize; 4],
}

impl Component {
    fn width(&self) -> usize {
        self.bounds[2] - self.bounds[0]
    }

    fn height(&self) -> usize {
        self.bounds[3] - self.bounds[1]
    }

    fn thin(&self) -> bool {
        self.width().max(self.height()) >= 12 * self.width().min(self.height()).max(1)
    }

    fn local(&self, page_width: usize, pad: usize) -> (Vec<u8>, usize, usize) {
        let (w, h) = (self.width() + 2 * pad, self.height() + 2 * pad);
        let mut local = vec![0; w * h];
        for &i in &self.pixels {
            let x = i % page_width - self.bounds[0] + pad;
            let y = i / page_width - self.bounds[1] + pad;
            local[y * w + x] = 255;
        }
        (local, w, h)
    }
}

fn components(binary: &[u8], w: usize, h: usize, mut visit: impl FnMut(&Component)) {
    let mut seen = vec![false; binary.len()];
    for seed in 0..binary.len() {
        if binary[seed] == 0 || seen[seed] {
            continue;
        }
        let mut component = Component {
            pixels: vec![seed],
            bounds: [seed % w, seed / w, seed % w + 1, seed / w + 1],
        };
        seen[seed] = true;
        let mut cursor = 0;
        while cursor < component.pixels.len() {
            let i = component.pixels[cursor];
            cursor += 1;
            let (x, y) = (i % w, i / w);
            component.bounds[0] = component.bounds[0].min(x);
            component.bounds[1] = component.bounds[1].min(y);
            component.bounds[2] = component.bounds[2].max(x + 1);
            component.bounds[3] = component.bounds[3].max(y + 1);
            for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    let neighbor = ny * w + nx;
                    if binary[neighbor] != 0 && !seen[neighbor] {
                        seen[neighbor] = true;
                        component.pixels.push(neighbor);
                    }
                }
            }
        }
        visit(&component);
    }
}

fn reflect101(mut p: isize, size: usize) -> usize {
    if size == 1 {
        return 0;
    }
    while p < 0 || p >= size as isize {
        p = if p < 0 { -p } else { 2 * size as isize - p - 2 };
    }
    p as usize
}

/// Separable Gaussian with OpenCV's default REFLECT_101 border.
fn gaussian(src: &[u8], w: usize, h: usize, radius: usize, sigma: f64) -> Vec<u8> {
    let mut taps: Vec<_> = (0..=2 * radius)
        .map(|i| {
            let x = i as f64 - radius as f64;
            (-x * x / (2.0 * sigma * sigma)).exp()
        })
        .collect();
    let sum: f64 = taps.iter().sum();
    for tap in &mut taps {
        *tap /= sum;
    }
    let mut horizontal = vec![0.0; src.len()];
    for y in 0..h {
        for x in 0..w {
            for (k, tap) in taps.iter().enumerate() {
                let sx = reflect101(x as isize + k as isize - radius as isize, w);
                horizontal[y * w + x] += f64::from(src[y * w + sx]) * tap;
            }
        }
    }
    let mut out = vec![0; src.len()];
    for y in 0..h {
        for x in 0..w {
            let mut value = 0.0;
            for (k, tap) in taps.iter().enumerate() {
                let sy = reflect101(y as isize + k as isize - radius as isize, h);
                value += horizontal[sy * w + x] * tap;
            }
            out[y * w + x] = value.round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Square morphology; clipped windows match the neutral default morphology border.
fn morph(src: &[u8], w: usize, h: usize, radius: usize, dilate: bool) -> Vec<u8> {
    let combine = |a: u8, b: u8| if dilate { a.max(b) } else { a.min(b) };
    let neutral = if dilate { 0 } else { 255 };
    let mut horizontal = vec![neutral; src.len()];
    for y in 0..h {
        for x in 0..w {
            for nx in x.saturating_sub(radius)..=(x + radius).min(w - 1) {
                horizontal[y * w + x] = combine(horizontal[y * w + x], src[y * w + nx]);
            }
        }
    }
    let mut out = vec![neutral; src.len()];
    for y in 0..h {
        for x in 0..w {
            for ny in y.saturating_sub(radius)..=(y + radius).min(h - 1) {
                out[y * w + x] = combine(out[y * w + x], horizontal[ny * w + x]);
            }
        }
    }
    out
}

fn mark_boxes(mask: &mut [u8], w: usize, h: usize, boxes: &[[i32; 4]], pad: i64) {
    for b in boxes {
        let x0 = (i64::from(b[0]) - pad).clamp(0, w as i64) as usize;
        let y0 = (i64::from(b[1]) - pad).clamp(0, h as i64) as usize;
        let x1 = (i64::from(b[2]) + pad).clamp(0, w as i64) as usize;
        let y1 = (i64::from(b[3]) + pad).clamp(0, h as i64) as usize;
        if x1 > x0 && y1 > y0 {
            for y in y0..y1 {
                mask[y * w + x0..y * w + x1].fill(255);
            }
        }
    }
}

fn bright_halo(gray: &[u8], w: usize, h: usize, component: &Component) -> bool {
    let (local, lw, lh) = component.local(w, 2);
    let ring = morph(&local, lw, lh, 2, true);
    let mut count = 0;
    let mut bright = 0;
    for y in 0..lh {
        for x in 0..lw {
            if ring[y * lw + x] != 0 && local[y * lw + x] == 0 {
                let sx = (component.bounds[0] as isize + x as isize - 2).clamp(0, w as isize - 1)
                    as usize;
                let sy = (component.bounds[1] as isize + y as isize - 2).clamp(0, h as isize - 1)
                    as usize;
                count += 1;
                bright += usize::from(gray[sy * w + sx] > 225);
            }
        }
    }
    count > 0 && bright as f64 >= count as f64 * 0.6
}

fn near_lettering(mask: &[u8], w: usize, h: usize) -> Vec<u8> {
    // OpenCV's 9x9 ellipse: each row's half-width is rounded to the nearest pixel.
    let mut out = vec![0; mask.len()];
    for (i, &pixel) in mask.iter().enumerate() {
        if pixel == 0 {
            continue;
        }
        let (x, y) = ((i % w) as isize, (i / w) as isize);
        for dy in -4isize..=4 {
            let ny = y + dy;
            if ny < 0 || ny >= h as isize {
                continue;
            }
            let dx = (4.0 * (1.0 - (dy * dy) as f64 / 16.0).sqrt()).round() as isize;
            let left = (x - dx).max(0) as usize;
            let right = (x + dx).min(w as isize - 1) as usize;
            out[ny as usize * w + left..=ny as usize * w + right].fill(255);
        }
    }
    out
}

/// Binary page-sized text ink, clipped to the supplied final boxes (exclusive far edges).
pub fn refine(page: &Raster, probability: &GrayImage, boxes: &[[i32; 4]]) -> GrayImage {
    let (w, h) = (page.w, page.h);
    assert_eq!(
        (page.cn, w, h),
        (
            3,
            probability.width() as usize,
            probability.height() as usize
        )
    );
    let mut mask = vec![0; w * h];
    if w == 0 || h == 0 || boxes.is_empty() {
        return GrayImage::from_raw(w as u32, h as u32, mask).unwrap();
    }
    let p = probability.as_raw();
    let mut support = vec![0; w * h];
    mark_boxes(&mut support, w, h, boxes, 2);
    let gray: Vec<u8> = page
        .data
        .as_chunks::<3>().0.iter()
        .map(|rgb| {
            ((u32::from(rgb[0]) * 4899
                + u32::from(rgb[1]) * 9617
                + u32::from(rgb[2]) * 1868
                + 8192)
                >> 14) as u8
        })
        .collect();
    let smooth = gaussian(&gray, w, h, 1, 0.7);
    let closing = morph(&morph(&smooth, w, h, 3, true), w, h, 3, false);
    let opening = morph(&morph(&smooth, w, h, 3, false), w, h, 3, true);
    let ink: Vec<u8> = (0..mask.len())
        .map(|i| {
            let dark = closing[i].saturating_sub(smooth[i]);
            let light = smooth[i].saturating_sub(opening[i]);
            u8::from(
                (dark > 18 && smooth[i] < 125)
                    || (light > 18 && smooth[i] > 240)
                    || (dark.max(light) > 18 && p[i] > 200 && support[i] != 0),
            )
        })
        .collect();
    drop(closing);
    drop(opening);
    let weak: Vec<_> = (0..mask.len())
        .map(|i| u8::from(p[i] >= WEAK && ink[i] != 0))
        .collect();
    components(&weak, w, h, |component| {
        let area = component.pixels.len();
        let strong = component.pixels.iter().filter(|&&i| p[i] >= STRONG).count();
        let supported = component
            .pixels
            .iter()
            .filter(|&&i| support[i] != 0)
            .count();
        let mean = component
            .pixels
            .iter()
            .map(|&i| f64::from(p[i]))
            .sum::<f64>()
            / area as f64;
        // This stage's thin guard is strict >; outline recovery below uses >=.
        let thin = component.width().max(component.height())
            > 12 * component.width().min(component.height()).max(1);
        if area >= 2
            && strong as f64 >= (area as f64 * 0.04).max(1.0)
            && (supported as f64 >= area as f64 * 0.5 || (mean > 130.0 && !thin))
        {
            for &i in &component.pixels {
                mask[i] = 255;
            }
        }
    });
    drop(weak);

    // Recover thick interiors without flooding through connected panel art.
    let dark: Vec<_> = gray.iter().map(|&v| u8::from(v < 125)).collect();
    components(&dark, w, h, |component| {
        let area = component.pixels.len();
        if area < 3 || (component.width() * component.height()) as f64 > (w * h) as f64 * 0.15 {
            return;
        }
        let evidence = component.pixels.iter().filter(|&&i| p[i] >= WEAK).count();
        let supported =
            evidence as f64 >= area as f64 * 0.3 && component.pixels.iter().any(|&i| mask[i] != 0);
        let outlined = !supported
            && evidence as f64 >= area as f64 * 0.03
            && !component.thin()
            && bright_halo(&gray, w, h, component);
        if supported || outlined {
            for &i in &component.pixels {
                mask[i] = 255;
            }
        }
    });
    drop(dark);

    let broad = gaussian(&gray, w, h, 7, 3.0);
    let bright: Vec<_> = (0..mask.len())
        .map(|i| u8::from(gray[i] > 225 && broad[i] < 220))
        .collect();
    drop(broad);
    components(&bright, w, h, |component| {
        let area = component.pixels.len();
        let mean = component
            .pixels
            .iter()
            .map(|&i| f64::from(smooth[i]))
            .sum::<f64>()
            / area as f64;
        if area < 12
            || component.thin()
            || !component.pixels.iter().any(|&i| p[i] >= WEAK)
            || mean <= 225.0
            || (component.width() * component.height()) as f64 >= (w * h) as f64 * 0.15
        {
            return;
        }
        let (local, lw, lh) = component.local(w, 0);
        let binary: Vec<_> = local.iter().map(|&v| v != 0).collect();
        let mut filled = vec![0; local.len()];
        for contour in find_contours(&binary, lw, lh) {
            fill_poly(&mut filled, lw, lh, &contour);
        }
        let bounded = morph(&local, lw, lh, 3, true);
        for y in 0..lh {
            for x in 0..lw {
                if filled[y * lw + x] != 0 && bounded[y * lw + x] != 0 {
                    mask[(y + component.bounds[1]) * w + x + component.bounds[0]] = 255;
                }
            }
        }
    });
    drop(bright);

    let near = near_lettering(&mask, w, h);
    for i in 0..mask.len() {
        if near[i] != 0 && support[i] != 0 && ink[i] != 0 && p[i] >= STRONG {
            mask[i] = 255;
        }
    }
    // Expanded support helps classify edge strokes, but grants no output outside boxes.
    support.fill(0);
    mark_boxes(&mut support, w, h, boxes, 0);
    for (pixel, allowed) in mask.iter_mut().zip(support) {
        if allowed == 0 {
            *pixel = 0;
        }
    }
    GrayImage::from_raw(w as u32, h as u32, mask).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(w: usize, h: usize, value: u8) -> Raster {
        Raster {
            w,
            h,
            cn: 3,
            data: vec![value; w * h * 3],
        }
    }

    fn rect(page: &mut Raster, probability: &mut GrayImage, b: [usize; 4], gray: u8, p: u8) {
        for y in b[1]..b[3] {
            for x in b[0]..b[2] {
                let i = (y * page.w + x) * 3;
                page.data[i..i + 3].fill(gray);
                probability.put_pixel(x as u32, y as u32, image::Luma([p]));
            }
        }
    }

    fn pixel(mask: &GrayImage, x: u32, y: u32) -> u8 {
        mask.get_pixel(x, y).0[0]
    }

    #[test]
    fn components_connect_diagonals_and_report_exclusive_bounds() {
        let binary = [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0];
        let mut found = Vec::new();
        components(&binary, 4, 3, |c| found.push((c.pixels.len(), c.bounds)));
        assert_eq!(found, [(3, [0, 0, 3, 3]), (1, [3, 0, 4, 1])]);
    }

    #[test]
    fn gaussian_and_morphology_keep_flat_images_including_single_pixel_axes() {
        for (w, h) in [(1, 1), (1, 8), (8, 1), (12, 9)] {
            let flat = vec![128; w * h];
            assert_eq!(gaussian(&flat, w, h, 1, 0.7), flat);
            assert_eq!(gaussian(&flat, w, h, 7, 3.0), flat);
            assert_eq!(morph(&flat, w, h, 3, true), flat);
            assert_eq!(morph(&flat, w, h, 3, false), flat);
        }
        assert_eq!(reflect101(-1, 4), 1);
        assert_eq!(reflect101(4, 4), 2);
    }

    #[test]
    fn refinement_needs_ink_and_returns_binary_page_pixels() {
        let mut image = page(48, 48, 255);
        let mut p = GrayImage::new(48, 48);
        rect(&mut image, &mut p, [20, 18, 23, 30], 0, 200);
        rect(&mut image, &mut p, [30, 20, 32, 26], 0, 64);
        let mask = refine(&image, &p, &[[10, 10, 40, 40]]);
        assert_eq!(mask.dimensions(), (48, 48));
        assert_eq!(pixel(&mask, 21, 24), 255);
        assert_eq!(pixel(&mask, 30, 23), 0, "faint art is not ink evidence");
        assert!(mask.as_raw().iter().all(|v| *v == 0 || *v == 255));
        let flat = refine(
            &page(48, 48, 128),
            &GrayImage::from_pixel(48, 48, image::Luma([255])),
            &[[0, 0, 48, 48]],
        );
        assert!(
            flat.as_raw().iter().all(|v| *v == 0),
            "probability alone is not ink"
        );
    }

    #[test]
    fn hysteresis_uses_weak_65_and_strong_150_inclusively() {
        for (probability, seed, expected) in
            [(64, 150, 0), (65, 150, 255), (149, 149, 0), (150, 150, 255)]
        {
            let mut image = page(48, 48, 128);
            let mut p = GrayImage::new(48, 48);
            rect(&mut image, &mut p, [20, 18, 23, 24], 0, probability);
            p.put_pixel(21, 20, image::Luma([seed]));
            let mask = refine(&image, &p, &[[10, 10, 35, 35]]);
            assert_eq!(
                pixel(&mask, 21, 21),
                expected,
                "p {probability}, seed {seed}"
            );
        }
    }

    #[test]
    fn final_clipping_uses_exact_boxes_and_handles_outside_or_empty_regions() {
        let mut image = page(48, 48, 255);
        let mut p = GrayImage::new(48, 48);
        rect(&mut image, &mut p, [18, 18, 23, 30], 0, 255);
        let mask = refine(&image, &p, &[[20, 20, 23, 27], [-100, -100, -1, -1]]);
        assert_eq!(pixel(&mask, 21, 24), 255);
        for (x, y, value) in mask.enumerate_pixels() {
            if !(20..23).contains(&x) || !(20..27).contains(&y) {
                assert_eq!(value.0[0], 0, "outside box at {x},{y}");
            }
        }
        assert!(refine(&image, &p, &[]).as_raw().iter().all(|v| *v == 0));
        assert!(refine(&image, &p, &[[30, 30, 20, 20], [60, 60, 70, 70]])
            .as_raw()
            .iter()
            .all(|v| *v == 0));
        assert_eq!(
            refine(&page(0, 0, 0), &GrayImage::new(0, 0), &[]).dimensions(),
            (0, 0)
        );
    }

    #[test]
    fn thick_dark_interiors_are_recovered_from_connected_supported_ink() {
        let mut image = page(48, 48, 128);
        let mut p = GrayImage::new(48, 48);
        rect(&mut image, &mut p, [20, 20, 30, 30], 0, 200);
        rect(&mut image, &mut p, [24, 14, 26, 20], 0, 200);
        let mask = refine(&image, &p, &[[10, 10, 38, 38]]);
        assert_eq!(pixel(&mask, 25, 25), 255);
        assert_eq!(pixel(&mask, 24, 16), 255);
    }

    #[test]
    fn bright_halos_recover_bold_dark_ink_with_sparse_segmentation() {
        let mut image = page(48, 48, 255);
        let mut p = GrayImage::new(48, 48);
        rect(&mut image, &mut p, [20, 20, 30, 30], 0, 0);
        p.put_pixel(20, 20, image::Luma([65]));
        p.put_pixel(21, 20, image::Luma([65]));
        let without = refine(&image, &p, &[[10, 10, 38, 38]]);
        assert_eq!(
            pixel(&without, 25, 25),
            0,
            "less than 3% evidence is rejected"
        );
        p.put_pixel(22, 20, image::Luma([65]));
        assert_eq!(pixel(&refine(&image, &p, &[[10, 10, 38, 38]]), 25, 25), 255);
    }

    #[test]
    fn bright_outline_recovery_fills_only_near_the_contour() {
        let mut image = page(48, 48, 20);
        let mut p = GrayImage::new(48, 48);
        rect(&mut image, &mut p, [16, 16, 32, 32], 255, 0);
        rect(&mut image, &mut p, [20, 20, 28, 28], 20, 0);
        p.put_pixel(17, 24, image::Luma([65]));
        let mask = refine(&image, &p, &[[12, 12, 36, 36]]);
        assert_eq!(pixel(&mask, 17, 24), 255, "the bright outline is recovered");
        assert_eq!(
            pixel(&mask, 20, 24),
            255,
            "nearby enclosed ink is recovered"
        );
        assert_eq!(pixel(&mask, 24, 24), 0, "large holes are not flooded");
        assert_eq!(pixel(&mask, 14, 24), 0);
    }

    #[test]
    fn detached_punctuation_requires_nearby_lettering_and_strong_evidence() {
        let mut image = page(48, 48, 128);
        let mut p = GrayImage::new(48, 48);
        rect(&mut image, &mut p, [21, 18, 24, 30], 0, 200);
        rect(&mut image, &mut p, [27, 24, 28, 25], 0, 150);
        rect(&mut image, &mut p, [27, 30, 28, 31], 0, 149);
        rect(&mut image, &mut p, [38, 24, 39, 25], 0, 255);
        let mask = refine(&image, &p, &[[10, 10, 44, 40]]);
        assert_eq!(pixel(&mask, 27, 24), 255);
        assert_eq!(pixel(&mask, 27, 30), 0);
        assert_eq!(pixel(&mask, 38, 24), 0);
    }
}
