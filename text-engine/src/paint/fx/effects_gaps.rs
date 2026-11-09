//! Test gaps from the Layer Styles review: F61 (`outline_share`), F62
//! (`stroke_frame`), F63 (a gradient overlay on a turned box), F64 (the
//! gradient's geometry) and F66 (the glows against Photoshop's numbers).
//!
//! F62, F64 and F66 port PhotoCraft's tests (`crates/compose/src/stroke_tests.rs`
//! `gradient_stroke_spans_the_strokes_extent`; `crates/compose/src/effects/tests.rs`
//! `gradient_geometry` and `glows_match_photoshop`), Copyright (c) 2026
//! ArtCraft Team and the PhotoCraft contributors, MIT licence (see
//! `THIRD_PARTY.md`).

use super::*;

const RED: Rgba = Rgba([255, 0, 0, 255]);

fn place() -> Place<'static> {
    Place {
        transform: Affine::IDENTITY,
        tiles: &[],
        grain: (0, 0),
    }
}

/// A square of red, `n` across, at device (10, 10).
fn square(n: u32) -> Raster {
    Raster {
        x: 10,
        y: 10,
        width: n,
        height: n,
        data: RED.0.repeat((n * n) as usize),
    }
}

fn black_to_white(angle: f32, style: gradient::Style) -> Gradient {
    Gradient {
        stops: vec![(0.0, [0.0; 3]), (1.0, [1.0; 3])],
        opacity: Vec::new(),
        style,
        angle,
        scale: 1.0,
        reverse: false,
        offset: (0.0, 0.0),
        noise: None,
    }
}

fn outside_stroke(size: f64, paint: Paint) -> Stroke {
    Stroke {
        size,
        position: Position::Outside,
        opacity: 1.0,
        blend: Blend::Normal,
        paint,
        seed: 0,
    }
}

// ---- F61: outline_share ----

#[test]
fn an_outline_takes_the_part_of_an_edge_pixel_the_letters_leave() {
    // A pixel the letters cover whole: no stroke under it.
    assert_eq!(outline_share(1.0, 1.0), 0.0);
    assert_eq!(outline_share(1.0, 0.3), 0.0);
    // Not covered at all, and the letters end clear: the stroke is whole.
    assert_eq!(outline_share(0.0, 0.0), 1.0);
    // Half covered, the letters ending at half alpha: the other half is the
    // stroke's, which is all that is left (0.5 / 0.5).
    assert!((outline_share(0.5, 0.5) - 1.0).abs() < 1e-6);
    // Half covered, the letters faded to a quarter: 0.5 of the three
    // quarters that are left.
    assert!((outline_share(0.5, 0.25) - 0.5 / 0.75).abs() < 1e-6);
    // Half covered, the letters gone (Fill Opacity 0): the half outside.
    assert!((outline_share(0.5, 0.0) - 0.5).abs() < 1e-6);
    // Nearly covered, the letters at half alpha: a tenth of the half left.
    assert!((outline_share(0.9, 0.5) - 0.2).abs() < 1e-6);
    // Never more than whole, whatever the letters' alpha says.
    assert_eq!(outline_share(0.5, 0.9), 1.0);
    assert_eq!(outline_share(0.5, 1.0), 1.0);
    // Out-of-range inputs are held to 0..1.
    assert_eq!(outline_share(-1.0, 0.0), 1.0);
    assert_eq!(outline_share(2.0, 0.0), 0.0);
}

/// F61: the share the box takes from `outline_share`, in the map the
/// strokes are slid under the letters by: a column covered by half, under
/// an outside stroke, the letters' fill at half Fill Opacity.
#[test]
fn an_outside_stroke_fills_what_a_half_covered_edge_leaves() {
    let _scope = budget::Scope::new();
    let n = 12;
    let mut r = square(n);
    // The first column covered by half; the rest whole.
    for y in 0..n as usize {
        r.data[y * n as usize * 4 + 3] = 128;
    }
    let fx = [Effect::Stroke(outside_stroke(
        3.0,
        Paint::Color(Rgba([0, 0, 0, 255])),
    ))];
    let share_at = |fill: f64, x: i32, y: i32| {
        let (_, o, _) = interior(&r, &fx, fill, false, 1.0, |x, y| (x, y), &place()).unwrap();
        let o = o.expect("an outside part");
        let (ix, iy) = ((x - o.dev.0) as usize, (y - o.dev.1) as usize);
        o.items[0].1[iy * o.w + ix]
    };
    // Fill 100 %: the letters end at half alpha, the stroke takes the other half
    // of it: whole.
    assert!((share_at(1.0, 10, 15) - 1.0).abs() < 1e-3);
    // Fill 50 %: they end at a quarter, and the stroke takes 0.5 of 0.75.
    let faded = share_at(0.5, 10, 15);
    assert!((faded - 0.665).abs() < 0.01, "{faded}");
    // Fill 0: the letters leave nothing, the stroke takes the half outside.
    let gone = share_at(0.0, 10, 15);
    assert!((gone - 0.498).abs() < 0.01, "{gone}");
    // A whole pixel of the letters: nothing; a pixel outside them: whole.
    assert_eq!(share_at(1.0, 15, 15), 0.0);
    assert!((share_at(1.0, 9, 15) - 1.0).abs() < 1e-3);
}

// ---- F62: stroke_frame ----

fn frame_of(size: f64, position: Position, px: f32, f: Frame) -> Frame {
    let st = Stroke {
        position,
        ..outside_stroke(size, Paint::Color(RED))
    };
    stroke_frame(f, &st, px)
}

/// PhotoCraft's `gradient_stroke_spans_the_strokes_extent`: a 4 px outside
/// stroke round a 20 px square (10..30) lays its gradient over 7..33, the
/// square grown by 3, and round a 22 px one over 28 px.
#[test]
fn a_stroke_gradient_spans_the_letters_grown_by_the_stroke_less_a_pixel() {
    assert_eq!(
        frame_of(4.0, Position::Outside, 1.0, [10.0, 10.0, 30.0, 30.0]),
        [7.0, 7.0, 33.0, 33.0]
    );
    let f = frame_of(4.0, Position::Outside, 1.0, [10.0, 10.0, 32.0, 32.0]);
    assert_eq!(f, [7.0, 7.0, 35.0, 35.0]);
    assert_eq!((f[2] - f[0], f[3] - f[1]), (28.0, 28.0));
    // A fraction of a pixel rounds up first: 2.5 px is 3, less one is 2.
    assert_eq!(
        frame_of(2.5, Position::Outside, 1.0, [10.0, 10.0, 30.0, 30.0]),
        [8.0, 8.0, 32.0, 32.0]
    );
    // A stroke under a pixel, or none outside (Inside), grows nothing.
    assert_eq!(
        frame_of(0.5, Position::Outside, 1.0, [10.0, 10.0, 30.0, 30.0]),
        [10.0, 10.0, 30.0, 30.0]
    );
    assert_eq!(
        frame_of(4.0, Position::Inside, 1.0, [10.0, 10.0, 30.0, 30.0]),
        [10.0, 10.0, 30.0, 30.0]
    );
    // A Center stroke is half out: 4 is 2 outside, less one is 1.
    assert_eq!(
        frame_of(4.0, Position::Center, 1.0, [10.0, 10.0, 30.0, 30.0]),
        [9.0, 9.0, 31.0, 31.0]
    );
    // At twice the zoom a job unit is two pixels: `px` is a half, the stroke
    // 8 device pixels, 7 spare, and the frame grows 3.5 job units.
    assert_eq!(
        frame_of(4.0, Position::Outside, 0.5, [10.0, 10.0, 30.0, 30.0]),
        [6.5, 6.5, 33.5, 33.5]
    );
}

/// The same case painted: the colours along the stroke are the gradient
/// over the stroke's frame (7..33), not the letters' (10..30); each row's
/// red is the ramp's `t` there.
#[test]
fn a_gradient_stroke_is_painted_over_the_strokes_frame() {
    let _scope = budget::Scope::new();
    let g = black_to_white(90.0, gradient::Style::Linear);
    let fx = [Effect::Stroke(outside_stroke(
        4.0,
        Paint::Gradient(g.clone()),
    ))];
    let (_, o, _) = interior(&square(20), &fx, 1.0, false, 1.0, |x, y| (x, y), &place()).unwrap();
    let mut s = Surface::new(40, 40).unwrap();
    lay_outside(&mut s, &o.unwrap(), &fx, &place(), None).unwrap();
    let want = |frame: Frame, y: usize| g.t(frame, 1.0, 20.5, y as f32 + 0.5);
    let (stroke_frame, letters_frame) = ([7.0, 7.0, 33.0, 33.0], [10.0, 10.0, 30.0, 30.0]);
    for y in [7usize, 9, 31, 32] {
        let p = &s.data[(y * 40 + 20) * 4..][..4];
        assert_eq!(p[3], 255, "row {y}");
        let got = f32::from(p[0]) / 255.0;
        assert!(
            (got - want(stroke_frame, y)).abs() <= 0.01,
            "row {y}: {got} vs {}",
            want(stroke_frame, y)
        );
    }
    // And the letters' own frame would have given other numbers.
    assert!((want(stroke_frame, 9) - want(letters_frame, 9)).abs() > 0.05);
}

// ---- F63: a gradient overlay on a turned box ----

/// F63: a box turned 30 degrees. Its gradient runs across the letters in
/// the box's own units, so its end stops lie at the letters' own two ends:
/// the frame is the letters', not the bounding box of the turned ones.
#[test]
fn a_gradient_overlay_on_a_turned_box_has_its_end_stops_at_the_letters_ends() {
    let _scope = budget::Scope::new();
    // Letters 20 job units across, centred on (30, 30), turned 30 degrees
    // about their centre and moved by (5, 5).
    let (s, c) = (30f64.to_radians().sin(), 30f64.to_radians().cos());
    let (cx, cy) = (30.0, 30.0);
    let transform = Affine([c, s, -s, c, cx - (c * cx - s * cy) + 5.0, cy - (s * cx + c * cy) + 5.0]);
    let to_job = transform.invert().unwrap();
    let n = 80u32;
    let mut data = vec![0u8; (n * n * 4) as usize];
    for y in 0..n {
        for x in 0..n {
            let p = to_job.apply(Pt::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
            if (20.0..40.0).contains(&p.x) && (20.0..40.0).contains(&p.y) {
                let i = ((y * n + x) * 4) as usize;
                data[i..i + 4].copy_from_slice(&[255, 0, 0, 255]);
            }
        }
    }
    let r = Raster {
        x: 0,
        y: 0,
        width: n,
        height: n,
        data,
    };
    let fx = [Effect::GradientOverlay(PaintOverlay {
        opacity: 1.0,
        blend: Blend::Normal,
        paint: Paint::Gradient(black_to_white(0.0, gradient::Style::Linear)),
    })];
    let turned = Place {
        transform,
        tiles: &[],
        grain: (0, 0),
    };
    let (out, _, _) = interior(&r, &fx, 1.0, false, 1.0, |x, y| (x, y), &turned).unwrap();
    // The red channel at a job point: the gradient's t there, 0 to 1.
    let t_at = |jx: f64, jy: f64| {
        let d = transform.apply(Pt::new(jx, jy));
        let (x, y) = (d.x.floor() as i32 - out.x, d.y.floor() as i32 - out.y);
        let i = (y as usize * out.width as usize + x as usize) * 4;
        assert_eq!(out.data[i + 3], 255, "({jx}, {jy}) is not on the letters");
        f64::from(out.data[i]) / 255.0
    };
    // Along the letters' x (the turned frame's own axis) from 0 to 1.
    let (left, mid, right) = (t_at(20.6, 30.0), t_at(30.0, 30.0), t_at(39.4, 30.0));
    assert!(left < 0.1, "left end {left}");
    assert!((mid - 0.5).abs() < 0.05, "middle {mid}");
    assert!(right > 0.9, "right end {right}");
    // Across the letters' y nothing changes it (angle 0 runs along x).
    for jy in [21.0, 39.0] {
        assert!((t_at(30.0, jy) - mid).abs() < 0.05, "y {jy}");
    }
    // The corners of the same end read the same, turned or not.
    assert!((t_at(20.6, 21.0) - left).abs() < 0.05);
    assert!((t_at(39.4, 39.0) - right).abs() < 0.05);
}

// ---- F64: the gradient's geometry ----

/// PhotoCraft's `gradient_geometry`: a 100 px square, `px` one.
#[test]
fn a_gradients_five_styles_hold_their_geometry() {
    let f = [0.0, 0.0, 100.0, 100.0];
    let t = |style, x, y| black_to_white(0.0, style).t(f, 1.0, x, y);
    use gradient::Style::*;
    assert!(t(Linear, 0.0, 50.0) < 0.01);
    // Linear and Reflected sample pixel corners: the centre is reached half
    // a pixel later.
    assert!((t(Linear, 50.5, 50.0) - 0.5).abs() < 1e-6);
    assert!(t(Linear, 100.0, 50.0) > 0.99);
    assert!(t(Reflected, 50.5, 50.0) < 1e-6);
    assert!((t(Reflected, 0.0, 50.0) - 1.0).abs() < 1e-6);
    assert!(t(Radial, 50.0, 50.0) < 1e-6);
    assert!((t(Radial, 50.0, 0.0) - 1.0).abs() < 1e-6);
    assert!((t(Diamond, 75.0, 75.0) - 1.0).abs() < 1e-6);
    let ang = t(Angle, 50.0, 0.0);
    assert!((ang - 0.75).abs() < 1e-3, "{ang}");
    let rev = Gradient {
        reverse: true,
        ..black_to_white(0.0, Linear)
    };
    assert!(rev.t(f, 1.0, 0.0, 50.0) > 0.99);
}

/// The Angle style sweeps clockwise from the gradient's angle, whole turns
/// apart, on screen (y down): the right side first at 0 degrees.
#[test]
fn the_angle_style_sweeps_clockwise_from_its_angle() {
    let f = [0.0, 0.0, 100.0, 100.0];
    let at = |angle: f32, x: f32, y: f32| black_to_white(angle, gradient::Style::Angle).t(f, 1.0, x, y);
    // At 0 degrees: right 0, bottom a quarter, left a half, top three quarters.
    for ((x, y), want) in [((100.0, 50.0), 0.0), ((50.0, 100.0), 0.25), ((0.0, 50.0), 0.5), ((50.0, 0.0), 0.75)] {
        let got = at(0.0, x, y);
        // The seam at 0 is 0 or 1.
        assert!(
            (got - want).abs() < 1e-3 || (want == 0.0 && (got - 1.0).abs() < 1e-3),
            "({x}, {y}): {got} vs {want}"
        );
    }
    // At 90 degrees the start is the top, and the sweep follows it round.
    for ((x, y), want) in [((50.0, 0.0), 0.0), ((100.0, 50.0), 0.25), ((50.0, 100.0), 0.5), ((0.0, 50.0), 0.75)] {
        let got = at(90.0, x, y);
        assert!(
            (got - want).abs() < 1e-3 || (want == 0.0 && (got - 1.0).abs() < 1e-3),
            "90: ({x}, {y}): {got} vs {want}"
        );
    }
    // The Angle style takes no Scale: it is a turn, not a length.
    let scaled = Gradient {
        scale: 0.25,
        ..black_to_white(0.0, gradient::Style::Angle)
    };
    assert_eq!(scaled.t(f, 1.0, 50.0, 100.0), at(0.0, 50.0, 100.0));
    // Reversed it runs the other way: 1 - t.
    let rev = Gradient {
        reverse: true,
        ..black_to_white(0.0, gradient::Style::Angle)
    };
    assert!((rev.t(f, 1.0, 50.0, 100.0) - 0.75).abs() < 1e-3);
}

/// Offset moves the centre by a share of the frame, along each axis of the
/// frame (not of the turned gradient), and the frame need not be square.
#[test]
fn a_gradients_offset_moves_its_centre_by_a_share_of_the_frame() {
    use gradient::Style::*;
    let f = [0.0, 0.0, 200.0, 100.0];
    // Linear at 0: the middle (t 0.5) is at x = 100 + 0.25 * 200 = 150, a
    // half pixel on.
    let g = Gradient {
        offset: (0.25, 0.0),
        ..black_to_white(0.0, Linear)
    };
    assert!((g.t(f, 1.0, 150.5, 50.0) - 0.5).abs() < 1e-6);
    assert!((g.t(f, 1.0, 100.5, 50.0) - 0.5).abs() > 0.2);
    // Radial: zero at the moved centre, (100 + 0.1 * 200, 50 + 0.2 * 100).
    let g = Gradient {
        offset: (0.1, 0.2),
        ..black_to_white(0.0, Radial)
    };
    assert!(g.t(f, 1.0, 120.0, 70.0) < 1e-6);
    assert!(g.t(f, 1.0, 100.0, 50.0) > 0.1);
    // Diamond and Reflected too.
    let g = Gradient {
        offset: (-0.25, 0.0),
        ..black_to_white(0.0, Diamond)
    };
    assert!(g.t(f, 1.0, 50.0, 50.0) < 1e-6);
    let g = Gradient {
        offset: (-0.25, 0.0),
        ..black_to_white(0.0, Reflected)
    };
    assert!(g.t(f, 1.0, 50.5, 50.0) < 1e-6);
    // The Angle style's seam moves with it: the right of the moved centre
    // is where the sweep starts.
    let g = Gradient {
        offset: (0.25, 0.0),
        ..black_to_white(0.0, Angle)
    };
    let (right, below) = (g.t(f, 1.0, 190.0, 50.0), g.t(f, 1.0, 150.0, 90.0));
    assert!(right < 1e-3 || right > 0.999, "{right}");
    assert!((below - 0.25).abs() < 1e-3, "{below}");
}

/// Scale stretches the run about the centre: at 50 % the ramp is done in
/// half the length, at 200 % it takes twice.
#[test]
fn a_gradients_scale_stretches_its_run_about_the_centre() {
    use gradient::Style::*;
    let f = [0.0, 0.0, 100.0, 100.0];
    let scaled = |style, scale| Gradient {
        scale,
        ..black_to_white(0.0, style)
    };
    // Linear: the chord is 100 * scale.
    let half = scaled(Linear, 0.5);
    assert!(half.t(f, 1.0, 25.5, 50.0) < 1e-6);
    assert!((half.t(f, 1.0, 50.5, 50.0) - 0.5).abs() < 1e-6);
    assert!((half.t(f, 1.0, 75.5, 50.0) - 1.0).abs() < 1e-6);
    let twice = scaled(Linear, 2.0);
    assert!((twice.t(f, 1.0, 100.5, 50.0) - 0.75).abs() < 1e-6);
    // Radial: the radius is 50 * scale.
    assert!((scaled(Radial, 0.5).t(f, 1.0, 50.0, 25.0) - 1.0).abs() < 1e-6);
    assert!((scaled(Radial, 2.0).t(f, 1.0, 50.0, 0.0) - 0.5).abs() < 1e-6);
    // Diamond and Reflected likewise.
    assert!((scaled(Diamond, 0.5).t(f, 1.0, 50.0, 25.0) - 1.0).abs() < 1e-6);
    assert!((scaled(Reflected, 0.5).t(f, 1.0, 75.5, 50.0) - 1.0).abs() < 1e-6);
    // A scale that is not a number is 100 %, and none is below 0.001.
    assert_eq!(
        scaled(Linear, f32::NAN).t(f, 1.0, 75.5, 50.0),
        scaled(Linear, 1.0).t(f, 1.0, 75.5, 50.0)
    );
    assert!(scaled(Linear, -3.0).t(f, 1.0, 51.0, 50.0) > 0.99);
}

// ---- F66: the glows against Photoshop's numbers ----

fn soft(size: f32, spread: f32, range: f32) -> Soft {
    let (grow, blur) = spread_split(f64::from(size), f64::from(spread));
    Soft {
        size,
        spread,
        grow: grow as f32,
        blur: blur as f32,
        contour: None,
        range,
        noise: 0.0,
        seed: 1,
        origin: (0, 0),
    }
}

/// PhotoCraft's `glows_match_photoshop` (Photoshop 27.11, a 20 px square on
/// a 60 px map, Normal black glow at 100 %, Range 50 %): a Precise glow's
/// coverage across the edge, and a Center-source inner glow as 1 - the edge.
#[test]
fn glows_match_photoshop() {
    let n = 60;
    let mut shape = Map::new(n, n, 0.0);
    for y in 20..40 {
        for x in 20..40 {
            shape.v[y * n + x] = 1.0;
        }
    }
    let at = |m: &Map, x: usize| m.v[30 * n + x];
    // Outer, Precise, size 10: Photoshop's black glow over white reads 47,
    // 93, 140, 186, 232 at 2, 4, 6, 8 and 10 px out from the edge pixel
    // (alpha 1 - D / 11).
    let m = map::glow(&shape, Technique::Precise, false, false, &soft(10.0, 0.0, 0.5)).unwrap();
    for (d, ps) in [(2, 47.0f32), (4, 93.0), (6, 140.0), (8, 186.0), (10, 232.0)] {
        let got = 255.0 * (1.0 - at(&m, 20 - d));
        assert!(
            (got - ps).abs() <= 1.5,
            "outer precise at {d} px: {got} vs Photoshop {ps}"
        );
    }
    // Spread 40 %: solid for the first 4 px.
    let m = map::glow(&shape, Technique::Precise, false, false, &soft(10.0, 0.4, 0.5)).unwrap();
    assert!((at(&m, 16) - 1.0).abs() < 1e-6 && at(&m, 14) < 1.0, "{} {}", at(&m, 16), at(&m, 14));
    // Centre source = 1 - edge, for both techniques.
    for t in [Technique::Precise, Technique::Softer] {
        let e = map::glow(&shape, t, true, false, &soft(6.0, 0.0, 0.5)).unwrap();
        let c = map::glow(&shape, t, true, true, &soft(6.0, 0.0, 0.5)).unwrap();
        for x in 20..40 {
            assert!(
                (at(&c, x) - (1.0 - at(&e, x))).abs() < 1e-5,
                "{t:?} at {x}"
            );
        }
    }
}
