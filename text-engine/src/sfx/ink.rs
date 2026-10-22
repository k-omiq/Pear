//! [`Ink`] from the engine: advances and outlines of a face, shaped with
//! harfrust and drawn with skrifa exactly as the painter draws a curved run.

use super::place::Ink;
use crate::engine::{Engine, Face};
use crate::paint::{curved_origin, glyph_polys, shape_run, Affine, Polys};
use crate::{Error, OBLIQUE_SKEW};

pub struct EngineInk<'a> {
    pub engine: &'a mut Engine,
    pub face: Face,
}

impl Ink for EngineInk<'_> {
    fn advance(&mut self, text: &str) -> Result<f64, Error> {
        self.engine.advance(self.face, text)
    }

    fn outline(&mut self, text: &str) -> Result<Vec<Vec<[f64; 2]>>, Error> {
        let shaped = shape_run(self.engine, self.face, text, 0.0)?;
        let (dx, dy) = curved_origin(self.engine, self.face, shaped.advance)?;
        let start = Affine::translate(dx, dy);
        // A coarse flattening: kerning bins are a few pixels wide.
        let tol = (self.face.size * 0.004).max(0.05);
        let mut polys = Polys::default();
        for g in &shaped.glyphs {
            let entry = self.engine.font(g.font)?;
            let per_unit = g.size / f64::from(entry.info.units_per_em);
            let skew = if g.synth.oblique {
                f64::from(OBLIQUE_SKEW)
            } else {
                0.0
            };
            let place = start.after(&Affine::translate(g.x, g.y));
            glyph_polys(entry, g.glyph, &place, per_unit, skew, tol, &mut polys);
        }
        let mut out = Vec::with_capacity(polys.ends.len());
        let mut from = 0;
        for &end in polys.ends.iter() {
            out.push(polys.pts[from..end].iter().map(|p| [p.x, p.y]).collect());
            from = end;
        }
        Ok(out)
    }
}
