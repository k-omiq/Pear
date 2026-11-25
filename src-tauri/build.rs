use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // Staging runs first: tauri_build resolves the bundle resources named by
    // tauri.<platform>.conf.json, and on Linux and Windows those point into
    // `gpu-libs/`. On a clean checkout that directory does not exist yet, so
    // resolving before staging fails the build outright.
    stage_gpu_libs();
    tauri_build::try_build(windows_manifest(tauri_build::Attributes::new())).expect("tauri-build failed");
}

/// The Windows app manifest (Common Controls 6), embedded by the linker in
/// every binary this package links rather than by tauri-build's resource file,
/// which reaches only the app. A `cargo test` binary without it gets Common
/// Controls 5, which lacks entry points Tauri imports, and Windows refuses to
/// start it: 0xC0000139 (STATUS_ENTRYPOINT_NOT_FOUND) before any test runs.
/// The file is tauri-build's own default manifest.
fn windows_manifest(attrs: tauri_build::Attributes) -> tauri_build::Attributes {
    let msvc = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !msvc {
        return attrs;
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
}

/// ONNX Runtime's GPU execution providers are shared libraries the bundle has
/// to carry. ort-sys drops them into the cargo profile directory, which moves
/// with `--target`, so this copies the ones the app registers into
/// `gpu-libs/` where `tauri.<platform>.conf.json` can name them.
///
/// `bin/` holds libraries ONNX Runtime dlopens from the executable's own
/// directory (it derives the path from the executable, no search path); they
/// must land beside the binary; on Windows the Microsoft C++ runtime joins
/// them (see `stage_vc_runtime`). `lib/` holds libraries the executable links
/// against, found through the rpath set below. Both directories always exist,
/// empty or not, because the bundle configs name them as directories: an
/// empty directory bundles nothing, a named file that is missing is an error
/// and a glob with no match is an error.
///
/// This runs after ort-sys's build script because Cargo.toml depends on
/// `ort-sys` directly - see the comment there before removing that line.
fn stage_gpu_libs() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    // OUT_DIR is target/<profile>/build/<pkg>-<hash>/out; three up is the
    // profile directory, the same walk ort-sys's copy-dylibs takes.
    let profile_dir = out_dir.ancestors().nth(3).expect("cargo profile dir");
    let stage = Path::new(env!("CARGO_MANIFEST_DIR")).join("gpu-libs");
    let _ = fs::remove_dir_all(&stage);
    for sub in ["bin", "lib"] {
        fs::create_dir_all(stage.join(sub)).expect("create gpu-libs");
    }

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let webgpu = env::var_os("CARGO_FEATURE_GPU_WEBGPU").is_some();
    let cuda = env::var_os("CARGO_FEATURE_GPU_CUDA").is_some();
    // ort-sys's own variables, read the same way it reads them: when set, it
    // links the ONNX Runtime in that directory instead of downloading pyke's.
    // The x86_64 Linux release does this with a build that runs on CPUs
    // without AVX (scripts/ci/build-onnxruntime-baseline.sh).
    let ort_lib = ["ORT_LIB_PATH", "ORT_LIB_LOCATION"]
        .map(|v| {
            println!("cargo:rerun-if-env-changed={v}");
            env::var_os(v)
        })
        .into_iter()
        .flatten()
        .next()
        .map(PathBuf::from);
    // With its own ONNX Runtime, ort-sys links libonnxruntime.a and nothing
    // else, so the Dawn library pyke's flow links and copies is ours to do.
    // --no-as-needed: this argument can land on the link line before the
    // archive that needs Dawn, and as-needed would drop it there.
    let src_dir = match &ort_lib {
        Some(dir) => {
            if target_os == "linux" && webgpu {
                println!("cargo:rustc-link-search=native={}", dir.display());
                println!("cargo:rustc-link-arg=-Wl,--push-state,--no-as-needed,-lwebgpu_dawn,--pop-state");
            }
            dir.as_path()
        }
        None => profile_dir,
    };
    // Only the libraries THIS configuration's providers actually need. A
    // CPU-only Linux build wants none; a Windows build always wants all three,
    // because `ort`'s Windows target turns on CUDA and DirectML unconditionally
    // (see Cargo.toml) and the ladder in src/detect/accel.rs registers both.
    let wanted: &[(&str, &str)] = match target_os.as_str() {
        "windows" => &[
            ("DirectML.dll", "bin"),
            ("onnxruntime_providers_shared.dll", "bin"),
            ("onnxruntime_providers_cuda.dll", "bin"),
        ],
        "linux" if cuda => &[
            ("libonnxruntime_providers_shared.so", "bin"),
            ("libonnxruntime_providers_cuda.so", "bin"),
        ],
        "linux" if webgpu => &[("libwebgpu_dawn.so", "lib")],
        _ => &[],
    };
    // Only a bundle can ship a library, and only `--release` produces one, so
    // that is where an unstageable library is fatal rather than a warning. A
    // `cargo check` or a dev build has nothing to ship and no reason to stop -
    // and it routinely sees this legitimately, because a restored build cache
    // leaves ort-sys's symlinks in the profile directory pointing at an OUT_DIR
    // the cache pruned.
    let fatal = env::var("PROFILE").as_deref() == Ok("release");
    for (name, sub) in wanted {
        let src = src_dir.join(name);
        // Loud, because every way this goes missing is silent downstream.
        // `DirectML.dll` is a load-time import of the executable on Windows
        // (ort-sys emits `rustc-link-lib=DirectML`), so a bundle without it
        // beside the binary either refuses to start or quietly binds to
        // whatever older copy Windows has in System32. The provider libraries
        // are dlopened, so losing one only downgrades the ladder a rung - just
        // as invisibly.
        if let Err(e) = fs::copy(&src, stage.join(sub).join(name)) {
            // `is_file` and `fs::copy` both follow the symlink ort-sys leaves,
            // which is also what makes the bundle get a real file rather than a
            // link - so say plainly which of the two failure shapes this is.
            let shape = match src.symlink_metadata() {
                Err(_) => "it is not there at all".to_string(),
                Ok(m) if m.is_symlink() => format!(
                    "it is a symlink to {}, which does not resolve",
                    fs::read_link(&src).map_or_else(
                        |e| format!("<unreadable: {e}>"),
                        |t| t.display().to_string()
                    )
                ),
                Ok(_) => format!("it is there but could not be read ({e})"),
            };
            let msg = format!(
                "cannot stage {name} from {}: {shape}. The {target_os} bundle needs it beside \
                 the executable. ort-sys puts the execution providers there, so a restored \
                 build cache that pruned its OUT_DIR is the usual cause: \
                 `cargo clean -p ort-sys`, or clear the CI cargo cache.",
                src_dir.display()
            );
            assert!(!fatal, "{msg}");
            println!("cargo:warning={msg}");
            continue;
        }
        println!("cargo:rerun-if-changed={}", src.display());
    }

    if target_os == "windows" && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        stage_vc_runtime(&stage.join("bin"), fatal);
    }

    if target_os == "linux" {
        // Dev builds find the dawn library beside the binary; installed builds
        // find it under the resource dir tauri.linux.conf.json ships it to.
        println!(
            "cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/Pear/gpu-libs/lib"
        );
        if !webgpu && !cuda {
            println!(
                "cargo:warning=CPU-only Linux build: detection runs on CPU. This is the \
                 expected ARM64 release lane; x86_64 builds may pass --features gpu-webgpu or gpu-cuda"
            );
        }
    }
}

/// The Microsoft C++ runtime, deployed app-local beside the executable.
///
/// pyke's ONNX Runtime is built against the DLL runtime (/MD), so the
/// executable imports msvcp140.dll and msvcp140_1.dll, and the provider
/// libraries import vcruntime140.dll and vcruntime140_1.dll as well. A clean
/// Windows has none of them - only the Universal CRT (`api-ms-win-crt-*`) is
/// part of the OS - so without these the installed app dies at once with
/// 0xC0000135 (DLL not found). A machine with Visual Studio, like every build
/// machine, has them in System32, which is why only a clean machine shows it.
///
/// Linking the runtime statically is not an option: `+crt-static` against
/// ORT's /MD objects is a RuntimeLibrary mismatch. Running vc_redist from the
/// installer would need admin rights the per-user NSIS install does not have.
/// Microsoft allows app-local deployment of the files in the Visual Studio
/// `Redist\MSVC\<version>\<arch>\Microsoft.VC14x.CRT` folder, and Windows
/// searches the executable's directory first, so the app also gets the runtime
/// it was built with rather than whatever older copy System32 holds.
///
/// Every DLL in that folder is copied; these are the ones something we ship
/// imports, so their absence fails a release build.
fn stage_vc_runtime(bin: &Path, fatal: bool) {
    const NEEDED: [&str; 4] = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];
    for v in ["VCToolsRedistDir", "VCINSTALLDIR"] {
        println!("cargo:rerun-if-env-changed={v}");
    }
    let fail = |msg: String| {
        let msg = format!(
            "{msg}. The Windows bundle needs the Microsoft C++ runtime beside the executable or \
             the app will not start on a machine without Visual Studio. Install the MSVC v14x \
             x64 redistributable component of Visual Studio (part of the C++ build tools \
             workload), or point VCToolsRedistDir at a `VC\\Redist\\MSVC\\<version>` folder."
        );
        assert!(!fatal, "{msg}");
        println!("cargo:warning={msg}");
    };
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x64",
        Ok("aarch64") => "arm64",
        Ok("x86") => "x86",
        other => return fail(format!("no MSVC runtime folder for target arch {other:?}")),
    };
    let Some(crt) = find_vc_crt_dir(arch) else {
        return fail(format!(
            "cannot find the Visual Studio {arch} C++ runtime folder \
             (VC\\Redist\\MSVC\\<version>\\{arch}\\Microsoft.VC14x.CRT)"
        ));
    };
    let entries = match fs::read_dir(&crt) {
        Ok(e) => e,
        Err(e) => return fail(format!("cannot read {}: {e}", crt.display())),
    };
    let mut copied = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !name.ends_with(".dll") {
            continue;
        }
        if let Err(e) = fs::copy(entry.path(), bin.join(&name)) {
            return fail(format!("cannot stage {name} from {}: {e}", crt.display()));
        }
        println!("cargo:rerun-if-changed={}", entry.path().display());
        copied.push(name);
    }
    let missing: Vec<_> = NEEDED.iter().filter(|n| !copied.iter().any(|c| c == *n)).collect();
    if !missing.is_empty() {
        fail(format!("{} has no {missing:?}", crt.display()));
    }
}

/// The newest `Microsoft.VC14x.CRT` folder for `arch`: from VCToolsRedistDir
/// when a Developer prompt set it, else from the Visual Studio vswhere finds.
/// cargo does not run under vcvars (rustc locates MSVC by itself), so on a
/// GitHub runner and a plain shell the vswhere path is the one taken.
fn find_vc_crt_dir(arch: &str) -> Option<PathBuf> {
    let crt_in = |redist_ver: PathBuf| -> Option<PathBuf> {
        let mut dirs: Vec<PathBuf> = fs::read_dir(redist_ver.join(arch))
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                p.is_dir() && n.starts_with("Microsoft.VC14") && n.ends_with(".CRT")
            })
            .collect();
        dirs.sort();
        dirs.pop()
    };
    if let Some(dir) = env::var_os("VCToolsRedistDir") {
        return crt_in(PathBuf::from(dir));
    }
    let vc_dirs: Vec<PathBuf> = match env::var_os("VCINSTALLDIR") {
        Some(dir) => vec![PathBuf::from(dir)],
        None => vswhere_installs().into_iter().map(|p| p.join("VC")).collect(),
    };
    for vc in vc_dirs {
        // The version this Visual Studio's own tools redistribute, when it
        // says; otherwise the highest numbered one present.
        let pinned = fs::read_to_string(vc.join(r"Auxiliary\Build\Microsoft.VCRedistVersion.default.txt"))
            .ok()
            .map(|v| vc.join(r"Redist\MSVC").join(v.trim()));
        if let Some(dir) = pinned.and_then(crt_in) {
            return Some(dir);
        }
        let mut versions: Vec<(Vec<u32>, PathBuf)> = fs::read_dir(vc.join(r"Redist\MSVC"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                let key: Option<Vec<u32>> = n.split('.').map(|s| s.parse().ok()).collect();
                key.map(|k| (k, e.path()))
            })
            .collect();
        versions.sort();
        if let Some(dir) = versions.into_iter().rev().find_map(|(_, p)| crt_in(p)) {
            return Some(dir);
        }
    }
    None
}

/// Visual Studio installs that have the x64 C++ tools, newest first.
fn vswhere_installs() -> Vec<PathBuf> {
    let Some(pf86) = env::var_os("ProgramFiles(x86)") else { return Vec::new() };
    let vswhere = PathBuf::from(pf86).join(r"Microsoft Visual Studio\Installer\vswhere.exe");
    let out = std::process::Command::new(vswhere)
        .args(["-latest", "-products", "*"])
        .args(["-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"])
        .args(["-property", "installationPath"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(PathBuf::from)
            .collect(),
        _ => Vec::new(),
    }
}
