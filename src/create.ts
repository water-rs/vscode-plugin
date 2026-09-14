import * as vscode from "vscode";
import { ensureWaterCliAvailable, runCliInTerminal } from "./cli";

const BACKEND_CHOICES = [
  { id: "apple", label: "Apple", detail: "iOS and macOS (UIKit/AppKit)" },
  { id: "android", label: "Android", detail: "Android Views" },
  { id: "gtk4", label: "GTK4", detail: "Linux desktop" },
  { id: "hydrolysis", label: "Hydrolysis", detail: "Self-drawn GPU renderer" },
  { id: "esp32", label: "ESP32", detail: "Dew embedded firmware" },
] as const;

interface BackendPickItem extends vscode.QuickPickItem {
  id: string;
}

/// `water create` as a guided flow: name, mode, backends, destination folder.
export async function createProject() {
  const name = await vscode.window.showInputBox({
    title: "New WaterUI Project",
    prompt: "Project display name (e.g. \"Water Example\")",
    validateInput: (value) =>
      value.trim().length === 0 ? "Name is required" : undefined,
  });
  if (!name) {
    return;
  }

  const mode = await vscode.window.showQuickPick(
    [
      {
        label: "Playground",
        description: "Quick experiments — platform runners are managed for you",
        value: "playground" as const,
      },
      {
        label: "App",
        description: "Full project with owned platform backends",
        value: "app" as const,
      },
    ],
    { placeHolder: "Project mode" }
  );
  if (!mode) {
    return;
  }

  const args = ["create", name.trim(), "--mode", mode.value];

  if (mode.value === "app") {
    const backends = await vscode.window.showQuickPick<BackendPickItem>(
      BACKEND_CHOICES.map((backend) => ({
        label: backend.label,
        description: backend.id,
        detail: backend.detail,
        id: backend.id,
      })),
      {
        placeHolder: "Backends to scaffold (empty = all defaults)",
        canPickMany: true,
      }
    );
    if (backends === undefined) {
      return;
    }
    if (backends.length) {
      args.push("--backends", backends.map((item) => item.id).join(","));
    }
  }

  const destination = await vscode.window.showOpenDialog({
    title: "Choose the parent folder for the new project",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Create Here",
  });
  const parent = destination?.[0];
  if (!parent) {
    return;
  }

  if (!(await ensureWaterCliAvailable())) {
    return;
  }

  runCliInTerminal("WaterUI Create", args, parent.fsPath);

  const open = await vscode.window.showInformationMessage(
    `Creating "${name}" in ${parent.fsPath} — open the folder when the command finishes?`,
    "Open Folder",
    "Dismiss"
  );
  if (open === "Open Folder") {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const folderUri = vscode.Uri.joinPath(parent, slug || name.trim());
    await vscode.commands.executeCommand("vscode.openFolder", folderUri, {
      forceNewWindow: false,
    });
  }
}
