// Compiles the vendored Signalsmith Stretch library (MIT, C++14, header-only plus a small C wrapper)
// used by Mashup Lab for time-stretching and formant-preserving pitch-shifting. Only a standard C++
// compiler is needed — the same one Tauri already requires.
fn main() {
    println!("cargo:rerun-if-changed=vendor/signalsmith");
    cc::Build::new()
        .cpp(true)
        .std("c++14")
        .file("vendor/signalsmith/wrapper.cpp")
        .include("vendor/signalsmith/signalsmith-stretch")
        .include("vendor/signalsmith")
        .flag_if_supported("-O3")
        .flag_if_supported("/O2")
        .warnings(false)
        .compile("signalsmith_stretch");
}
