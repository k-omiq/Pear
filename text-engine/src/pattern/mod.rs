//! A crop turned into one repeating lattice cell. The texture is in lattice
//! coordinates, not page coordinates; its origin is the crop centre, in pixel
//! edge coordinates. Sampling a page pixel therefore starts at (x + .5, y + .5).
//! These routines share the painter's fallible allocation budget, but neither
//! borrow its ABI state nor need a font or a painter job.

mod extract;
mod fft;

pub use extract::{extract, Tile, MAX_SIDE};
