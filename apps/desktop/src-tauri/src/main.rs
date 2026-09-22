// Suppresses the console window a release build would otherwise open on
// Windows. Debug builds keep it, which is where the CI/local `cargo check`
// and `tauri build --debug` gates in this task run.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hermie_desktop_lib::run();
}
