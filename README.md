# WaterUI VSCode Extension

This extension connects Visual Studio Code to the [`water`](../../cli/src/lib.rs) CLI so you can work with WaterUI projects without leaving the editor.

## Features

- **Show Devices** – Runs `water --json devices`, displays the available simulators/emulators, and lets you copy their identifiers.
- **Run Project** – Uses `water run` to launch the workspace project. You can optionally pin a device and choose the build profile.
- **Package Project** – Wraps `water package` with quick-pick options for `--platform`, `--all`, and `--release`.
- **View Trait Highlighting** – A semantic tokens provider piggybacks on rust-analyzer data so `impl View for Type` targets are highlighted without manual scans.
- **Inline CLI Installer** – If `water` is missing the extension offers a `cargo install` (stable) or GitHub `dev` install workflow.
- **Doctor Diagnostics** – Taps into `water --json doctor` to surface toolchain issues directly, with optional automatic fix execution.
- **Configurable CLI Path** – If `water` is not on your `PATH`, point the extension at an absolute executable path via `WaterUI › CLI Path`.

## Getting started

1. Inside `ide-support/vscode`, run `npm install`.
2. Use `npm run build` (or `npm run watch`) to compile `src/extension.ts` into `dist/extension.js`.
3. Launch the VSCode Extension Host (`F5`) or package with `vsce package`.

## Commands

| Command | Palette Label | Details |
| --- | --- | --- |
| `waterui.devices.show` | WaterUI: Show Devices | Lists devices via `water --json devices`. |
| `waterui.run` | WaterUI: Run Project | Prompts for device/build profile, then runs `water run`. |
| `waterui.package` | WaterUI: Package Project | Prompts for platform and profile, calls `water package`. |
| `waterui.doctor` | WaterUI: Diagnose Environment | Executes `water --json doctor`, renders sections, and optionally applies fixes. |

Each command targets the selected workspace folder (or the only folder when a single-root workspace is open) and passes it to the CLI via `--project`.
