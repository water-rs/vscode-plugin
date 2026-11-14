import * as vscode from "vscode";
import {
  ensureWaterCliAvailable,
  execWater,
  isCliRequiredMessage,
  runCliInTerminal,
} from "./cli";
import { getOutputChannel } from "./output";
import {
  DestinationPicker,
  DeviceInfo,
  fetchDevices,
  promptForDevice,
} from "./devices";
import { WaterUITaskProvider, WATERUI_TASK_TYPE } from "./tasks";
import { createProject } from "./create";
import { attachInspector } from "./inspector";
import { registerPreview } from "./preview";
import { registerWaterTomlSchema } from "./waterToml";

interface DeviceQuickPickItem extends vscode.QuickPickItem {
  device: DeviceInfo | null;
}

interface ValueQuickPickItem<T> extends vscode.QuickPickItem {
  value: T;
}

interface WorkspaceQuickPickItem extends vscode.QuickPickItem {
  folder: vscode.WorkspaceFolder;
}

type DoctorRowStatus = "pass" | "warn" | "fail" | "info";

/// One line of `water doctor --json`: the CLI streams check results as JSONL.
interface DoctorEvent {
  status?: string;
  level?: string;
  message?: string;
}

interface DoctorReport {
  rows: DoctorEvent[];
  hasWarnings: boolean;
  fixableCount: number;
}

const viewTraitSemanticLegend = new vscode.SemanticTokensLegend(["type"], []);

export function activate(context: vscode.ExtensionContext) {
  const destinationPicker = new DestinationPicker(context);

  const showDevicesDisposable = vscode.commands.registerCommand(
    "waterui.devices.show",
    showDevices
  );
  const destinationDisposable = vscode.commands.registerCommand(
    "waterui.destination.pick",
    () => destinationPicker.pick()
  );
  const runDisposable = vscode.commands.registerCommand(
    "waterui.run",
    () => runProject(destinationPicker)
  );
  const packageDisposable = vscode.commands.registerCommand(
    "waterui.package",
    packageProject
  );
  const doctorDisposable = vscode.commands.registerCommand(
    "waterui.doctor",
    runDoctor
  );
  const createDisposable = vscode.commands.registerCommand(
    "waterui.create",
    createProject
  );
  const inspectorDisposable = vscode.commands.registerCommand(
    "waterui.inspector.attach",
    attachInspector
  );

  const taskProvider = vscode.tasks.registerTaskProvider(
    WATERUI_TASK_TYPE,
    new WaterUITaskProvider()
  );

  const semanticTokensProvider =
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "rust", scheme: "file" },
      new ViewTraitSemanticTokensProvider(),
      viewTraitSemanticLegend
    );

  context.subscriptions.push(
    destinationPicker,
    showDevicesDisposable,
    destinationDisposable,
    runDisposable,
    packageDisposable,
    doctorDisposable,
    createDisposable,
    inspectorDisposable,
    taskProvider,
    semanticTokensProvider,
    ...registerPreview(context)
  );

  void registerWaterTomlSchema(context);
}

export function deactivate() {
  // no-op
}

async function showDevices() {
  try {
    const devices = await vscode.window.withProgress<DeviceInfo[]>(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Querying WaterUI devices...",
      },
      async () => fetchDevices()
    );

    const channel = getOutputChannel();
    channel.clear();
    if (!devices.length) {
      channel.appendLine(
        "No devices detected. Connect a device or start a simulator, then try again."
      );
      channel.show(true);
      vscode.window.showInformationMessage("WaterUI: No devices detected.");
      return;
    }

    channel.appendLine("WaterUI devices:");
    channel.appendLine("");
    for (const device of devices) {
      const detailParts = [device.platform, device.kind, device.state].filter(
        Boolean
      );
      channel.appendLine(`${device.name} (${detailParts.join(" • ")})`);
      channel.appendLine(`  id: ${device.identifier}`);
      if (device.detail) {
        channel.appendLine(`  info: ${device.detail}`);
      }
      channel.appendLine("");
    }
    channel.show(true);

    const quickPickItems: DeviceQuickPickItem[] = devices.map((device) => ({
      label: device.name,
      description: `${device.platform} • ${device.kind}`,
      detail:
        [device.identifier, device.state, device.detail]
          .filter(Boolean)
          .join(" | ") || undefined,
      device,
    }));

    const selection = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder:
        "Select a device to copy its identifier, or press Esc to cancel",
    });

    if (selection?.device) {
      await vscode.env.clipboard.writeText(selection.device.identifier);
      vscode.window.showInformationMessage(
        `Device identifier copied: ${selection.device.identifier}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `WaterUI: Failed to list devices. ${message}`
    );
  }
}

async function runProject(destinationPicker: DestinationPicker) {
  const workspaceFolder = await pickWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  const stored = destinationPicker.current();
  let platformArg: string | undefined;
  let deviceArg: string | undefined;

  if (stored) {
    platformArg = stored.platform;
    deviceArg = stored.deviceId;
  } else {
    let selectedDevice: DeviceInfo | null | undefined;
    try {
      const devices = await fetchDevices();
      selectedDevice = await promptForDevice(devices, true);
      if (selectedDevice === undefined) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isCliRequiredMessage(message)) {
        vscode.window.showErrorMessage(message);
        return;
      }
      const proceed = await vscode.window.showWarningMessage(
        `WaterUI: Unable to list devices (${message}). Continue and let the CLI prompt for a target?`,
        "Continue",
        "Cancel"
      );
      if (proceed !== "Continue") {
        return;
      }
      selectedDevice = null;
    }
    if (selectedDevice) {
      platformArg = selectedDevice.platform;
      deviceArg = selectedDevice.identifier;
    }
  }

  const buildSelection = await vscode.window.showQuickPick<
    ValueQuickPickItem<"debug" | "release">
  >(
    [
      {
        label: "Debug (default)",
        description: "Fast builds with hot reload",
        value: "debug",
      },
      {
        label: "Release",
        description: "Optimized build (uses --release)",
        value: "release",
      },
    ],
    { placeHolder: "Select a build profile" }
  );
  if (!buildSelection) {
    return;
  }

  const args = ["run", "--project", workspaceFolder.uri.fsPath];
  if (platformArg) {
    args.push("--platform", platformArg);
  }
  if (deviceArg) {
    args.push("--device", deviceArg);
  }
  if (buildSelection.value === "release") {
    args.push("--release");
  }

  if (!(await ensureWaterCliAvailable())) {
    return;
  }

  runCliInTerminal("WaterUI Run", args, workspaceFolder.uri.fsPath);
}

async function packageProject() {
  const workspaceFolder = await pickWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  const platformSelection = await vscode.window.showQuickPick<
    ValueQuickPickItem<"all" | "android" | "ios">
  >(
    [
      {
        label: "All Configured Platforms",
        description: "Equivalent to `water package --all`",
        value: "all",
      },
      {
        label: "Android",
        description: "Package the Android backend",
        value: "android",
      },
      {
        label: "iOS",
        description: "Package the iOS (Swift) backend",
        value: "ios",
      },
    ],
    {
      placeHolder: "Select a WaterUI packaging target",
    }
  );
  if (!platformSelection) {
    return;
  }

  const buildSelection = await vscode.window.showQuickPick<
    ValueQuickPickItem<"debug" | "release">
  >(
    [
      { label: "Debug", description: "Skip --release flag", value: "debug" },
      { label: "Release", description: "Adds --release", value: "release" },
    ],
    { placeHolder: "Select package configuration" }
  );
  if (!buildSelection) {
    return;
  }

  const args = ["package", "--project", workspaceFolder.uri.fsPath];
  if (platformSelection.value === "all") {
    args.push("--all");
  } else {
    args.push("--platform", platformSelection.value);
  }
  if (buildSelection.value === "release") {
    args.push("--release");
  }

  if (!(await ensureWaterCliAvailable())) {
    return;
  }

  runCliInTerminal("WaterUI Package", args, workspaceFolder.uri.fsPath);
}

async function runDoctor() {
  if (!(await ensureWaterCliAvailable())) {
    return;
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath;

  try {
    const report = await vscode.window.withProgress<DoctorReport>(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Running WaterUI doctor...",
      },
      async () => getDoctorReport(false, cwd)
    );
    displayDoctorReport(report, workspaceFolder);
    await maybeHandleDoctorSuggestions(report, workspaceFolder, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`WaterUI doctor failed. ${message}`);
  }
}

async function maybeHandleDoctorSuggestions(
  report: DoctorReport,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  cwd: string | undefined
) {
  if (!report.hasWarnings) {
    vscode.window.showInformationMessage("WaterUI doctor: all checks passed.");
    return;
  }

  const action = await vscode.window.showWarningMessage(
    `WaterUI doctor found ${report.fixableCount || "some"} issues needing attention.`,
    "Apply Fixes",
    "Dismiss"
  );
  if (action === "Apply Fixes") {
    try {
      const fixReport = await vscode.window.withProgress<DoctorReport>(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Applying WaterUI doctor fixes...",
        },
        async () => getDoctorReport(true, cwd)
      );
      displayDoctorReport(fixReport, workspaceFolder);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `WaterUI doctor failed to apply fixes. ${message}`
      );
    }
  }
}

function doctorRowStatus(row: DoctorEvent): DoctorRowStatus {
  if (row.status === "✓") {
    return "pass";
  }
  if (row.level === "warning" || row.level === "warn") {
    return "warn";
  }
  if (row.level === "error") {
    return "fail";
  }
  return "info";
}

async function getDoctorReport(
  applyFixes: boolean,
  cwd: string | undefined
): Promise<DoctorReport> {
  const args = ["doctor", "--json"];
  if (applyFixes) {
    args.push("--fix");
  }
  const stdout = await execWater(args, cwd);
  const rows: DoctorEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed) as DoctorEvent);
    } catch {
      // non-JSON line, skip
    }
  }
  if (!rows.length) {
    throw new Error(
      "No JSON events in `water doctor` output — is this a recent CLI?"
    );
  }
  const fixableCount = rows.filter((row) =>
    row.message?.includes("[fixable]")
  ).length;
  const hasWarnings = rows.some(
    (row) => doctorRowStatus(row) === "warn" || doctorRowStatus(row) === "fail"
  );
  return { rows, hasWarnings, fixableCount };
}

function displayDoctorReport(
  report: DoctorReport,
  workspaceFolder: vscode.WorkspaceFolder | undefined
) {
  const channel = getOutputChannel();
  channel.clear();
  const workspaceLabel = workspaceFolder
    ? `workspace "${workspaceFolder.name}"`
    : "current environment";
  channel.appendLine(`WaterUI doctor report (${workspaceLabel})`);
  channel.appendLine("");

  for (const row of report.rows) {
    const status = doctorRowStatus(row);
    channel.appendLine(`${statusIcon(status)} ${row.message?.trim() ?? ""}`);
  }

  channel.appendLine("");
  channel.appendLine(
    report.hasWarnings
      ? `${report.fixableCount} fixable issue(s) — re-run with --fix to apply.`
      : "All checks passed."
  );
  channel.show(true);
}

function statusIcon(status: DoctorRowStatus): string {
  switch (status) {
    case "pass":
      return "✔";
    case "warn":
      return "⚠";
    case "fail":
      return "✘";
    default:
      return "•";
  }
}

async function pickWorkspaceFolder(): Promise<
  vscode.WorkspaceFolder | undefined
> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(
      "WaterUI: Open a project folder before running this command."
    );
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }

  const selection = await vscode.window.showQuickPick<WorkspaceQuickPickItem>(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    { placeHolder: "Select the WaterUI workspace folder" }
  );

  return selection?.folder;
}

class ViewTraitSemanticTokensProvider
  implements vscode.DocumentSemanticTokensProvider
{
  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.SemanticTokens> {
    const builder = new vscode.SemanticTokensBuilder(viewTraitSemanticLegend);
    const ranges = await findViewTraitRanges(document, token);
    for (const range of ranges) {
      if (token.isCancellationRequested) {
        break;
      }
      builder.push(
        range.start.line,
        range.start.character,
        range.end.character - range.start.character,
        0,
        0
      );
    }
    return builder.build();
  }
}

async function findViewTraitRanges(
  document: vscode.TextDocument,
  token?: vscode.CancellationToken
): Promise<vscode.Range[]> {
  try {
    const symbols =
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        document.uri
      )) || [];
    const ranges: vscode.Range[] = [];
    const stack: vscode.DocumentSymbol[] = [...symbols];
    while (stack.length) {
      if (token?.isCancellationRequested) {
        break;
      }
      const symbol = stack.pop()!;
      stack.push(...(symbol.children || []));
      const range = createViewTraitRange(symbol, document);
      if (range) {
        ranges.push(range);
      }
    }
    return ranges;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.debug("WaterUI: failed to read rust-analyzer symbols:", message);
    return [];
  }
}

function createViewTraitRange(
  symbol: vscode.DocumentSymbol,
  document: vscode.TextDocument
): vscode.Range | undefined {
  const name = symbol.name.toLowerCase();
  if (!name.includes("view") || !name.startsWith("impl")) {
    return undefined;
  }
  const symbolText = document.getText(symbol.selectionRange);
  const match =
    /for\s+([A-Za-z0-9_:<>,'\s]+?)(?=\s*(?:where|\{))/i.exec(symbolText);
  if (!match) {
    return undefined;
  }
  const rawTypeName = match[1];
  const typeName = rawTypeName.trim();
  if (!typeName.length) {
    return undefined;
  }

  const selectionStartOffset = document.offsetAt(symbol.selectionRange.start);
  const rawStart = symbolText.indexOf(rawTypeName, match.index);
  if (rawStart < 0) {
    return undefined;
  }
  const leadingWhitespace =
    rawTypeName.length - rawTypeName.trimStart().length;
  const startOffset =
    selectionStartOffset + rawStart + leadingWhitespace;
  const endOffset = startOffset + typeName.length;
  const startPos = document.positionAt(startOffset);
  const endPos = document.positionAt(endOffset);

  return new vscode.Range(startPos, endPos);
}
