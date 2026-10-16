use super::*;
use std::time::Instant;

fn random(seed: &mut u32) -> f64 {
    *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
    *seed as f64 / u32::MAX as f64
}

fn tone(w: usize, h: usize, period: f64, degrees: f64, lines: bool, noisy: bool) -> Vec<u8> {
    let (s, c) = degrees.to_radians().sin_cos();
    let mut out = vec![255; w * h * 4];
    let mut seed = 1729;
    for y in 0..h {
        for x in 0..w {
            let mut ink = 0.0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = x as f64 + (sx as f64 + 0.5) / 4.0;
                    let py = y as f64 + (sy as f64 + 0.5) / 4.0;
                    let u = (c * px + s * py) / period;
                    let v = (-s * px + c * py) / period;
                    let u = u - u.round();
                    let v = v - v.round();
                    if if lines {
                        u.abs() < 0.23
                    } else {
                        u * u + v * v < 0.09
                    } {
                        ink += 1.0;
                    }
                }
            }
            let disturbance = if noisy {
                (random(&mut seed) - 0.5) * 40.0 + 30.0 * (x as f64 / w as f64 - 0.5)
            } else {
                0.0
            };
            let level = (215.0 - 170.0 * ink / 16.0 + disturbance).round() as u8;
            let i = (y * w + x) * 4;
            out[i..i + 3].fill(level);
        }
    }
    out
}

fn repaint(tile: &Tile, w: usize, h: usize, original: &[u8]) -> f64 {
    let det = cross(tile.a, tile.b);
    let n = tile.side as i32;
    let at = |x: i32, y: i32| {
        tile.pixels[(y.rem_euclid(n) as usize * tile.side + x.rem_euclid(n) as usize) * 4] as f64
    };
    let mut error = 0.0;
    let mut count = 0;
    for y in h / 2 - 32..h / 2 + 32 {
        for x in w / 2 - 32..w / 2 + 32 {
            // Both sides represent the same bilinear field: the extractor is
            // explicitly required to average bilinear samples of the original.
            // Quarter-pixel probes cover the centre region without comparing a
            // filtered reconstruction with unfiltered, discrete source pixels.
            for (dx, dy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                let source = [x as f64 + dx, y as f64 + dy];
                let p = [source[0] - w as f64 / 2.0, source[1] - h as f64 / 2.0];
                let u = cross(p, tile.b) / det * n as f64 - 0.5;
                let v = cross(tile.a, p) / det * n as f64 - 0.5;
                let ix = u.floor() as i32;
                let iy = v.floor() as i32;
                let (u, v) = (u - ix as f64, v - iy as f64);
                let actual = (at(ix, iy) * (1.0 - u) + at(ix + 1, iy) * u) * (1.0 - v)
                    + (at(ix, iy + 1) * (1.0 - u) + at(ix + 1, iy + 1) * u) * v;
                error += (actual - sample_rgb(w, original, source)[0]).abs();
                count += 1;
            }
        }
    }
    error / count as f64
}

#[test]
fn noisy_rotated_dots_recover_reduced_basis_and_repaint() {
    for (period, angle) in [(7.3, 45.0), (6.0, 15.0), (6.35, 27.0)] {
        let clean = tone(300, 300, period, angle, false, false);
        let input = tone(300, 300, period, angle, false, true);
        let tile = extract(300, 300, &input).unwrap();
        let lengths = [length(tile.a), length(tile.b)];
        let error = repaint(&tile, 300, 300, &clean);
        let (s, c) = angle.to_radians().sin_cos();
        let expected = [[c * period, s * period], [-s * period, c * period]];
        // A square lattice has four equivalent choices of first vector. Match
        // the reduced pair up to signs and order, rather than requiring the
        // arbitrary tie between their equal lengths to go one particular way.
        let matches = |got: Point, want: Point| {
            length(add(got, scale(want, -1.0))).min(length(add(got, want))) / period
        };
        let direct = matches(tile.a, expected[0]).max(matches(tile.b, expected[1]));
        let swapped = matches(tile.a, expected[1]).max(matches(tile.b, expected[0]));
        let angle_error = ((tile.info()[3] - angle + 45.0).rem_euclid(90.0) - 45.0).abs();
        eprintln!("dots p={period} angle={angle}: lengths={lengths:?}, angle_error={angle_error:.4}deg confidence={:.4} repaint_MAE={error:.4}", tile.confidence);
        assert!(tile.periodic, "{tile:?}");
        assert!(lengths.iter().all(|v| (v / period - 1.0).abs() < 0.01));
        assert!(direct.min(swapped) < 0.01);
        assert!(angle_error < 1.0);
        assert!(cross(tile.a, tile.b) > 0.0);
        assert!(tile.a[0] > 0.0 || (tile.a[0] == 0.0 && tile.a[1] > 0.0));
        assert!(tile.confidence >= 0.5);
        assert!(error < 8.0, "repaint MAE={error}");
        assert!(tile.pixels.chunks_exact(4).all(|p| p[3] == 255));
    }
}

#[test]
fn parallel_lines_use_a_square_cell_and_repeat_correctly() {
    let input = tone(300, 300, 5.5, 30.0, true, true);
    let clean = tone(300, 300, 5.5, 30.0, true, false);
    let tile = extract(300, 300, &input).unwrap();
    let error = repaint(&tile, 300, 300, &clean);
    eprintln!(
        "lines: a={:?} b={:?} confidence={:.4} repaint_MAE={error:.4}",
        tile.a, tile.b, tile.confidence
    );
    assert!(tile.periodic);
    assert!((length(tile.a) / 5.5 - 1.0).abs() < 0.01);
    assert!((length(tile.b) / 5.5 - 1.0).abs() < 0.01);
    assert!(dot(tile.a, tile.b).abs() < 1e-8);
    assert!(tile.confidence >= 0.5);
    assert!(error < 8.0, "line repaint MAE={error}");
}

#[test]
fn white_noise_is_nonperiodic_and_its_wrap_is_an_ordinary_neighbour() {
    let side = 128;
    let mut seed = 934;
    let input: Vec<u8> = (0..side * side * 4)
        .map(|_| (random(&mut seed) * 255.0) as u8)
        .collect();
    let tile = extract(side, side, &input).unwrap();
    assert!(!tile.periodic);
    assert_eq!(tile.confidence, 0.0);
    assert_eq!(tile.a, [side as f64, 0.0]);
    assert_eq!(tile.b, [0.0, side as f64]);
    let pixel = |x: usize, y: usize| tile.pixels[(y * side + x) * 4] as f64;
    let mut seam = [0.0; 2];
    let mut adjacent = [0.0; 2];
    for i in 0..side {
        seam[0] += (pixel(0, i) - pixel(side - 1, i)).abs();
        seam[1] += (pixel(i, 0) - pixel(i, side - 1)).abs();
        adjacent[0] += (pixel(1, i) - pixel(0, i)).abs();
        adjacent[1] += (pixel(i, 1) - pixel(i, 0)).abs();
    }
    for axis in 0..2 {
        eprintln!(
            "fallback axis {axis}: seam={:.3}, neighbouring={:.3}",
            seam[axis] / side as f64,
            adjacent[axis] / side as f64
        );
        assert!((seam[axis] / adjacent[axis] - 1.0).abs() < 0.25);
    }
}

#[test]
fn too_few_repeats_and_tiny_crops_use_centred_fallback() {
    let crop = tone(20, 20, 9.0, 0.0, false, false);
    let tile = extract(20, 20, &crop).unwrap();
    assert!(!tile.periodic);
    assert!(tile.confidence < 0.35);
    for (w, h) in [(1, 1), (2, 7), (15, 30), (30, 15)] {
        let mut crop = vec![0; w * h * 4];
        for (i, p) in crop.chunks_exact_mut(4).enumerate() {
            p.copy_from_slice(&[i as u8, 70, 90, 0]);
        }
        let tile = extract(w, h, &crop).unwrap();
        let side = w.min(h);
        assert!(!tile.periodic);
        assert_eq!(tile.side, side);
        let shifted_source = ((((h - side) / 2 + side / 2) * w) + (w - side) / 2 + side / 2) * 4;
        assert_eq!(&tile.pixels[..3], &crop[shifted_source..shifted_source + 3]);
        assert!(tile.pixels.chunks_exact(4).all(|p| p[3] == 255));
    }
}

#[test]
fn validates_allocation_bounds_and_ignores_alpha() {
    for (w, h, data) in [
        (0, 1, &[][..]),
        (1025, 1, &[][..]),
        (usize::MAX, 1, &[][..]),
        (1, 1, &[0, 0, 0][..]),
    ] {
        assert!(extract(w, h, data).is_err());
    }
    let opaque = tone(64, 96, 7.3, 45.0, false, false);
    let mut transparent = opaque.clone();
    for p in transparent.chunks_exact_mut(4) {
        p[3] = 0;
    }
    let a = extract(64, 96, &opaque).unwrap();
    let b = extract(64, 96, &transparent).unwrap();
    assert!(a.periodic);
    assert_eq!(a.info(), b.info());
    assert_eq!(a.pixels, b.pixels);
    let _scope = budget::Scope::new();
    budget::limit_for_test(16);
    assert!(extract(64, 96, &opaque).is_err());
}

#[test]
fn maximum_crop_native_release_timing() {
    let input = tone(1024, 1024, 7.3, 45.0, false, true);
    let mut elapsed = [0.0; 3];
    for time in &mut elapsed {
        let start = Instant::now();
        let tile = extract(1024, 1024, &input).unwrap();
        *time = start.elapsed().as_secs_f64() * 1000.0;
        assert!(tile.periodic);
        assert!((length(tile.a) / 7.3 - 1.0).abs() < 0.01);
    }
    elapsed.sort_by(f64::total_cmp);
    eprintln!(
        "1024x1024 native extraction milliseconds: {elapsed:?}; median={:.3}",
        elapsed[1]
    );
}

#[test]
fn clipped_cell_rows_match_the_definition_for_straight_colour() {
    let (w, h, n) = (41, 33, 16);
    let input: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            [
                (i * 13 % 256) as u8,
                (i * 29 % 256) as u8,
                (i * 7 % 256) as u8,
                0,
            ]
        })
        .collect();
    let a = [4.1, 1.3];
    let b = [-0.7, 5.2];
    let pixels = average_cell(w, h, &input, a, b, n).unwrap();
    for j in 0..n {
        for i in 0..n {
            let mut sum = [0.0; 3];
            let mut count = 0;
            for l in -20..=20 {
                for k in -20..=20 {
                    let u = (i as f64 + 0.5) / n as f64 + k as f64;
                    let v = (j as f64 + 0.5) / n as f64 + l as f64;
                    let p = add(
                        [w as f64 / 2.0, h as f64 / 2.0],
                        add(scale(a, u), scale(b, v)),
                    );
                    if p[0] >= 1.0 - 1e-9
                        && p[0] <= w as f64 - 1.0 + 1e-9
                        && p[1] >= 1.0 - 1e-9
                        && p[1] <= h as f64 - 1.0 + 1e-9
                    {
                        let rgb = sample_rgb(w, &input, p);
                        for c in 0..3 {
                            sum[c] += rgb[c];
                        }
                        count += 1;
                    }
                }
            }
            for c in 0..3 {
                assert!(
                    (pixels[(j * n + i) * 4 + c] as f64 - sum[c] / count as f64).abs() <= 0.501,
                    "texel ({i}, {j}), channel {c}: got {}, expected {:.6}, samples {count}",
                    pixels[(j * n + i) * 4 + c],
                    sum[c] / count as f64
                );
            }
            assert_eq!(pixels[(j * n + i) * 4 + 3], 255);
        }
    }
}
