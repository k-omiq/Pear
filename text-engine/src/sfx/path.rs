//! The path a text group runs along: a quadratic curve from `a` to `b`,
//! bent sideways by `bend`, and walked by arc length.

/// A path. Units are the caller's (ems on the wire, pixels in the layout).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Path {
    pub a: [f64; 2],
    pub b: [f64; 2],
    /// The control point sits off the chord's middle by `bend` times the
    /// chord, to the right of the direction of travel (y down).
    pub bend: f64,
}

/// Samples the arc-length table is built from.
const STEPS: usize = 160;

impl Path {
    pub fn scaled(&self, k: f64) -> Path {
        Path {
            a: [self.a[0] * k, self.a[1] * k],
            b: [self.b[0] * k, self.b[1] * k],
            bend: self.bend,
        }
    }

    pub fn control(&self) -> [f64; 2] {
        let [ax, ay] = self.a;
        let [bx, by] = self.b;
        [
            (ax + bx) / 2.0 - (by - ay) * self.bend,
            (ay + by) / 2.0 + (bx - ax) * self.bend,
        ]
    }

    /// Point and (unnormalised) tangent at curve parameter `t`.
    pub fn at_t(&self, t: f64) -> ([f64; 2], [f64; 2]) {
        let [ax, ay] = self.a;
        let [bx, by] = self.b;
        let [cx, cy] = self.control();
        let u = 1.0 - t;
        (
            [
                u * u * ax + 2.0 * u * t * cx + t * t * bx,
                u * u * ay + 2.0 * u * t * cy + t * t * by,
            ],
            [
                2.0 * u * (cx - ax) + 2.0 * t * (bx - cx),
                2.0 * u * (cy - ay) + 2.0 * t * (by - cy),
            ],
        )
    }
}

/// A path measured for walking by distance.
pub struct Walker {
    path: Path,
    acc: [f64; STEPS + 1],
}

impl Walker {
    pub fn new(path: Path) -> Self {
        let mut acc = [0.0; STEPS + 1];
        let mut prev = path.at_t(0.0).0;
        for (i, slot) in acc.iter_mut().enumerate().skip(1) {
            let p = path.at_t(i as f64 / STEPS as f64).0;
            *slot = (p[0] - prev[0]).hypot(p[1] - prev[1]);
            prev = p;
        }
        for i in 1..=STEPS {
            acc[i] += acc[i - 1];
        }
        Self { path, acc }
    }

    pub fn len(&self) -> f64 {
        self.acc[STEPS]
    }

    /// The point `s` along the path (clamped to its ends) and the unit
    /// direction of travel there. A path with no length points along +x.
    pub fn at(&self, s: f64) -> ([f64; 2], [f64; 2]) {
        let s = s.clamp(0.0, self.len());
        let (mut lo, mut hi) = (0usize, STEPS);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.acc[mid] < s {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let span = (self.acc[hi] - self.acc[lo]).max(1e-12);
        let t = (lo as f64 + (s - self.acc[lo]) / span) / STEPS as f64;
        let (p, d) = self.path.at_t(t.clamp(0.0, 1.0));
        let len = d[0].hypot(d[1]);
        let dir = if len > 1e-12 {
            [d[0] / len, d[1] / len]
        } else {
            let c = [
                self.path.b[0] - self.path.a[0],
                self.path.b[1] - self.path.a[1],
            ];
            let l = c[0].hypot(c[1]);
            if l > 1e-12 {
                [c[0] / l, c[1] / l]
            } else {
                [1.0, 0.0]
            }
        };
        (p, dir)
    }
}
