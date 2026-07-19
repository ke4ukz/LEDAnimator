//! Put the platform's `memory-<t>.x` where the linker finds it (as `memory.x`),
//! and the cortex-m-rt linker search path with it. The active platform is chosen
//! by the Cargo feature (`CARGO_FEATURE_RP2040` / `CARGO_FEATURE_RP2350`); the
//! target triple + any boot2 link script are set in `.cargo/config.toml`.
use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

fn main() {
    // Pick the memory layout for the selected platform. Both files are embedded in
    // this build script; only the active one is written out.
    let memory_x: &[u8] = if env::var_os("CARGO_FEATURE_RP2040").is_some() {
        include_bytes!("memory-rp2040.x")
    } else {
        // Default / rp2350. (board/mod.rs `compile_error!`s if neither feature is
        // set, so this only ever runs for a real RP2350 build.)
        include_bytes!("memory-rp2350.x")
    };

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    File::create(out.join("memory.x"))
        .unwrap()
        .write_all(memory_x)
        .unwrap();
    println!("cargo:rustc-link-search={}", out.display());

    println!("cargo:rerun-if-changed=memory-rp2040.x");
    println!("cargo:rerun-if-changed=memory-rp2350.x");
    println!("cargo:rerun-if-changed=build.rs");
}
