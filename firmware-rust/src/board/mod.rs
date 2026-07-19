//! Board / platform layer — the **single place** hardware targets differ.
//!
//! This is the Rust analog of an Arduino board-variant header: the rest of the
//! firmware is written once against `board::*`, and each supported chip supplies
//! its own constants here. Exactly one platform feature is active per build; the
//! `compile_error!`s below turn a missing/ambiguous selection into a clear error
//! instead of a confusing downstream failure.
//!
//! **Adding a target** = one Cargo feature (`Cargo.toml`), one `board/<t>.rs`, one
//! `memory-<t>.x`, and a `build.rs` arm. Nothing else in `src/` should need a
//! per-chip `#[cfg]` — if it does, hoist that difference up into here.

#[cfg(all(feature = "rp2040", feature = "rp2350"))]
compile_error!("features `rp2040` and `rp2350` are mutually exclusive — build one platform at a time");
#[cfg(not(any(feature = "rp2040", feature = "rp2350")))]
compile_error!("no platform selected — enable exactly one of `rp2040` / `rp2350` (default = rp2350)");

#[cfg(feature = "rp2040")]
mod rp2040;
#[cfg(feature = "rp2040")]
pub use rp2040::*;

#[cfg(feature = "rp2350")]
mod rp2350;
#[cfg(feature = "rp2350")]
pub use rp2350::*;
