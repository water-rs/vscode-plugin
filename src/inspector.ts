import * as vscode from "vscode";
import { ensureWaterCliAvailable, runCliInTerminal } from "./cli";

/// Attaches the WaterUI inspector to a running app.
///
/// The endpoint address and one-time token are printed by `water run` when the
/// app starts; the editor side is only the entry point — discovery on the
/// endpoint itself is tracked upstream (water-rs/waterui#89).
export async function attachInspector() {
  const target = await vscode.window.showInputBox({
    title: "Attach WaterUI Inspector",
    prompt: "Inspector endpoint address (e.g. 127.0.0.1:4747)",
    placeHolder: "host:port",
    validateInput: (value) =>
      value.trim().length === 0 ? "Endpoint address is required" : undefined,
  });
  if (!target) {
    return;
  }

  const token = await vscode.window.showInputBox({
    title: "Attach WaterUI Inspector",
    prompt: "One-time session token (printed by `water run`)",
    placeHolder: "token",
  });
  if (token === undefined) {
    return;
  }

  if (!(await ensureWaterCliAvailable())) {
    return;
  }

  const args = ["inspector", "--target", target.trim()];
  if (token.trim().length) {
    args.push("--token", token.trim());
  }
  const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (projectDir) {
    args.push("--path", projectDir);
  }
  runCliInTerminal("WaterUI Inspector", args, projectDir);
}
