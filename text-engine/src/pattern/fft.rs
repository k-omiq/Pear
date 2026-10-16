//! Small radix-two FFT for the autocorrelation. One plan is reused for all
//! rows and columns, so there is no trigonometry or allocation in a butterfly.
//! The inverse divides by the length on each axis. Transposing between passes
//! keeps both sets of transforms contiguous, including in wasm memory.

use crate::paint::budget::{self, Buffer};
use crate::Error;

#[derive(Clone, Copy, Default)]
pub(super) struct Complex {
    pub re: f64,
    pub im: f64,
}

pub(super) struct Plan {
    reverse: Buffer<usize>,
    roots: Buffer<Complex>,
}

impl Plan {
    pub fn new(n: usize) -> Result<Self, Error> {
        if n < 2 || !n.is_power_of_two() {
            return Err(Error::BadSpec);
        }
        let mut reverse = budget::filled(n, 0usize)?;
        let bits = n.trailing_zeros();
        for (i, r) in reverse.iter_mut().enumerate() {
            *r = i.reverse_bits() >> (usize::BITS - bits);
        }
        let mut roots = budget::filled(n / 2, Complex::default())?;
        for (i, r) in roots.iter_mut().enumerate() {
            let angle = -std::f64::consts::TAU * i as f64 / n as f64;
            (r.im, r.re) = angle.sin_cos();
        }
        Ok(Self { reverse, roots })
    }

    pub fn transform(&self, values: &mut [Complex], inverse: bool) {
        let n = self.reverse.len();
        assert_eq!(values.len(), n);
        for (i, &j) in self.reverse.iter().enumerate() {
            if i < j {
                values.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let stride = n / len;
            for chunk in values.chunks_exact_mut(len) {
                let (left, right) = chunk.split_at_mut(half);
                for (j, (a, b)) in left.iter_mut().zip(right).enumerate() {
                    let root = self.roots[j * stride];
                    let im = if inverse { -root.im } else { root.im };
                    let re = b.re * root.re - b.im * im;
                    let imag = b.re * im + b.im * root.re;
                    *b = Complex {
                        re: a.re - re,
                        im: a.im - imag,
                    };
                    a.re += re;
                    a.im += imag;
                }
            }
            len *= 2;
        }
        if inverse {
            for v in values {
                v.re /= n as f64;
                v.im /= n as f64;
            }
        }
    }

    pub fn square(&self, values: &mut [Complex], inverse: bool) {
        let n = self.reverse.len();
        assert_eq!(values.len(), n * n);
        for _ in 0..2 {
            for row in values.chunks_exact_mut(n) {
                self.transform(row, inverse);
            }
            // Work on small pairs of blocks so both sides of a transpose fit
            // in cache. A full, strided column otherwise evicts the other side
            // long before the next row needs it on a 1024-square analysis.
            for by in (0..n).step_by(32) {
                for bx in (0..=by).step_by(32) {
                    for y in by..(by + 32).min(n) {
                        for x in bx..(bx + 32).min(n).min(y) {
                            values.swap(y * n + x, x * n + y);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_matches_naive_dft_and_inverse_round_trips() {
        for n in [2, 4, 8, 16, 32] {
            let original: Vec<_> = (0..n)
                .map(|i| Complex {
                    re: (i as f64 * 1.7).sin(),
                    im: (i as f64 * 0.3).cos(),
                })
                .collect();
            let mut actual = original.clone();
            let plan = Plan::new(n).unwrap();
            plan.transform(&mut actual, false);
            for (k, got) in actual.iter().enumerate() {
                let mut expected = Complex::default();
                for (j, v) in original.iter().enumerate() {
                    let t = -std::f64::consts::TAU * (j * k) as f64 / n as f64;
                    expected.re += v.re * t.cos() - v.im * t.sin();
                    expected.im += v.re * t.sin() + v.im * t.cos();
                }
                assert!((got.re - expected.re).abs() < 1e-10);
                assert!((got.im - expected.im).abs() < 1e-10);
            }
            plan.transform(&mut actual, true);
            for (got, expected) in actual.iter().zip(original) {
                assert!((got.re - expected.re).abs() < 1e-12);
                assert!((got.im - expected.im).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn square_round_trip_and_invalid_plan() {
        assert!(Plan::new(0).is_err());
        assert!(Plan::new(3).is_err());
        let mut data = [Complex::default(); 64];
        data[19].re = 3.0;
        let plan = Plan::new(8).unwrap();
        plan.square(&mut data, false);
        plan.square(&mut data, true);
        for (i, v) in data.iter().enumerate() {
            assert!((v.re - if i == 19 { 3.0 } else { 0.0 }).abs() < 1e-12);
            assert!(v.im.abs() < 1e-12);
        }
    }
}
