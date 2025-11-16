import * as vscode from "vscode";
import { execFile, spawn, SpawnOptionsWithoutStdio } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";

const execFileAsync = promisify(execFile);

type DeviceKind = "simulator" | "device" | "emulator";

interface DeviceInfo {
  platform: string;
  raw_platform?: string;
  name: string;
  identifier: string;
  kind: DeviceKind;
  state?: string;
  detail?: string;
}

interface DeviceQuickPickItem extends vscode.QuickPickItem {
  device: DeviceInfo | null;
}

interface ValueQuickPickItem<T> extends vscode.QuickPickItem {
  value: T;
}

interface WorkspaceQuickPickItem extends vscode.QuickPickItem {
  folder: vscode.WorkspaceFolder;
}

type DoctorStatus = "pass" | "warn" | "fail";
type DoctorRowStatus = DoctorStatus | "info";

interface DoctorReport {
  status: DoctorStatus;
  sections: DoctorSection[];
  suggestions: FixSuggestion[];
  applied_fixes?: FixApplication[];
}

interface DoctorSection {
  title: string;
  rows: DoctorRow[];
}

interface DoctorRow {
  status: DoctorRowStatus;
  message: string;
  detail?: string;
  indent: number;
}

interface FixSuggestion {
  id: string;
  description: string;
  command: string[];
}

type FixApplicationOutcome = "applied" | "skipped" | "failed" | "unavailable";

interface FixApplication {
  id: string;
  description: string;
  command: string[];
  outcome: FixApplicationOutcome;
  detail?: string;
}

let outputChannel: vscode.OutputChannel | undefined;
const viewTraitSemanticLegend = new vscode.SemanticTokensLegend(["type"], []);

export function activate(context: vscode.ExtensionContext) {
  const showDevicesDisposable = vscode.commands.registerCommand(
    "waterui.devices.show",
    showDevices
  );
  const runDisposable = vscode.commands.registerCommand(
    "waterui.run",
    runProject
  );
  const packageDisposable = vscode.commands.registerCommand(
    "waterui.package",
    packageProject
  );
  const doctorDisposable = vscode.commands.registerCommand(
    "waterui.doctor",
    runDoctor
  );

  const semanticTokensProvider =
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "rust" },
      new ViewTraitSemanticTokensProvider(),
      viewTraitSemanticLegend
    );

  context.subscriptions.push(
    showDevicesDisposable,
    runDisposable,
    packageDisposable,
    doctorDisposable,
    semanticTokensProvider
  );
}

export function deactivate() {
  // no-op
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("WaterUI");
  }
  return outputChannel;
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

async function runProject() {
  const workspaceFolder = await pickWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

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
  if (selectedDevice) {
    args.push("--device", selectedDevice.identifier);
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
  if (!report.suggestions.length || report.status === "pass") {
    const toast = `WaterUI doctor status: ${report.status.toUpperCase()}`;
    if (report.status === "pass") {
      vscode.window.showInformationMessage(toast);
    } else {
      vscode.window.showWarningMessage(toast);
    }
    return;
  }

  const action = await vscode.window.showWarningMessage(
    "WaterUI doctor found toolchain issues. Run automatic fixes?",
    "Apply Fixes",
    "Copy Fix Commands",
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
    return;
  }

  if (action === "Copy Fix Commands") {
    const commands = report.suggestions
      .map((suggestion) => suggestion.command.join(" "))
      .filter((command) => command.length > 0);
    if (!commands.length) {
      vscode.window.showInformationMessage(
        "Doctor suggestions do not include runnable commands."
      );
      return;
    }
    await vscode.env.clipboard.writeText(commands.join("\n"));
    vscode.window.showInformationMessage(
      "WaterUI doctor fix commands copied to clipboard."
    );
  }
}

async function getDoctorReport(
  applyFixes: boolean,
  cwd: string | undefined
): Promise<DoctorReport> {
  const args = ["--json", "doctor"];
  if (applyFixes) {
    args.push("--fix");
  }
  const stdout = await execWater(args, cwd);
  try {
    return JSON.parse(stdout) as DoctorReport;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse WaterUI doctor JSON output. ${reason}. Please ensure you are running the latest CLI.`
    );
  }
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
  channel.appendLine(
    `Status: ${statusIcon(report.status)} ${report.status.toUpperCase()}`
  );
  channel.appendLine("");

  for (const section of report.sections) {
    const sectionStatus = summarizeSectionStatus(section);
    channel.appendLine(
      `${statusIcon(sectionStatus)} ${section.title} [${sectionStatus.toUpperCase()}]`
    );
    for (const row of section.rows) {
      const indent = "  ".repeat(row.indent + 1);
      channel.appendLine(
        `${indent}${statusIcon(row.status)} ${row.message.trim()}`
      );
      if (row.detail) {
        const detailIndent = "  ".repeat(row.indent + 2);
        channel.appendLine(`${detailIndent}${row.detail.trim()}`);
      }
    }
    channel.appendLine("");
  }

  if (report.applied_fixes && report.applied_fixes.length) {
    channel.appendLine("Applied fixes:");
    for (const fix of report.applied_fixes) {
      channel.appendLine(
        `- ${fix.description} (${fix.outcome.toUpperCase()})${
          fix.detail ? ` — ${fix.detail}` : ""
        }`
      );
    }
    channel.appendLine("");
  }

  if (report.suggestions.length) {
    channel.appendLine("Fix suggestions:");
    for (const suggestion of report.suggestions) {
      const commandPreview = suggestion.command.join(" ");
      channel.appendLine(`- ${suggestion.description}`);
      if (commandPreview.length) {
        channel.appendLine(`    ${commandPreview}`);
      }
    }
  } else {
    channel.appendLine("No fix suggestions required.");
  }

  channel.show(true);
}

function summarizeSectionStatus(section: DoctorSection): DoctorRowStatus {
  if (section.rows.some((row) => row.status === "fail")) {
    return "fail";
  }
  if (section.rows.some((row) => row.status === "warn")) {
    return "warn";
  }
  if (section.rows.some((row) => row.status === "pass")) {
    return "pass";
  }
  return "info";
}

function statusIcon(status: DoctorRowStatus | DoctorStatus): string {
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

async function fetchDevices(): Promise<DeviceInfo[]> {
  const stdout = await execWater(["--json", "devices"]);
  try {
    const parsed = JSON.parse(stdout.trim() || "[]");
    if (Array.isArray(parsed)) {
      return parsed as DeviceInfo[];
    }
    return [];
  } catch (error) {
    throw new Error(
      `Unable to parse CLI response: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function promptForDevice(
  devices: DeviceInfo[],
  includeAuto: boolean
): Promise<DeviceInfo | null | undefined> {
  if (!devices.length && !includeAuto) {
    vscode.window.showWarningMessage("WaterUI: No devices available.");
    return undefined;
  }

  const items: DeviceQuickPickItem[] = [];
  if (includeAuto) {
    items.push({
      label: "Let WaterUI choose",
      description: "The CLI will prompt for a device if needed",
      device: null,
    });
  }
  for (const device of devices) {
    items.push({
      label: device.name,
      description: `${device.platform} • ${device.kind}`,
      detail:
        [device.identifier, device.state, device.detail]
          .filter(Boolean)
          .join(" | ") || undefined,
      device,
    });
  }

  if (!items.length) {
    vscode.window.showWarningMessage(
      "WaterUI: No devices detected. Connect a device or start a simulator."
    );
    return undefined;
  }

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a device to run on",
  });
  return selection?.device;
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

async function execWater(args: string[], cwd?: string): Promise<string> {
  const command = getCliPath();
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
    });
    return stdout.toString();
  } catch (error) {
    if (isMissingCliError(error)) {
      const installed = await promptInstallCli();
      if (installed) {
        return execWater(args, cwd);
      }
      throw new Error("WaterUI CLI is required. Install it and try again.");
    }
    const err = error as { stderr?: string; message?: string };
    const stderr = err.stderr?.toString().trim();
    throw new Error(stderr || err.message || "Water CLI command failed.");
  }
}

function getCliPath(): string {
  const configuration = vscode.workspace.getConfiguration("waterui");
  const cliPath = configuration.get<string>("cliPath")?.trim();
  return cliPath && cliPath.length > 0 ? cliPath : "water";
}

function runCliInTerminal(name: string, args: string[], cwd?: string) {
  const cliPath = getCliPath();
  const command = [quoteArg(cliPath), ...args.map(quoteArg)].join(" ");
  const terminal = vscode.window.createTerminal({ name, cwd });
  terminal.show(true);
  terminal.sendText(command, true);
}

function quoteArg(value: string): string {
  if (/^[\w@%+=:,./-]+$/i.test(value)) {
    return value;
  }
  const escaped = value.replace(/(["\\$`])/g, "\\$1");
  return `"${escaped}"`;
}

function isMissingCliError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: string | number; message?: string };
  if (err.code === "ENOENT") {
    return true;
  }
  const message = (err.message || "").toLowerCase();
  return (
    message.includes("not found") || message.includes("could not be spawned")
  );
}

function isCliRequiredMessage(message: string): boolean {
  return message.toLowerCase().includes("waterui cli is required");
}

async function ensureWaterCliAvailable(): Promise<boolean> {
  try {
    await execWater(["--version"]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(message);
    return false;
  }
}

async function promptInstallCli(): Promise<boolean> {
  const selection = await vscode.window.showInformationMessage(
    "WaterUI CLI (water) was not found. Would you like to install it now?",
    { modal: true },
    "Stable Install",
    "Dev Install"
  );
  if (!selection) {
    return false;
  }
  if (selection === "Stable Install") {
    return installCliStable();
  }
  if (selection === "Dev Install") {
    return installCliDev();
  }
  return false;
}

async function installCliStable(): Promise<boolean> {
  const channel = getOutputChannel();
  channel.show(true);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Installing WaterUI CLI (stable)",
      },
      async () => {
        channel.appendLine("> cargo install waterui-cli");
        await runCommandWithOutput(
          "cargo",
          ["install", "waterui-cli"],
          {},
          channel
        );
      }
    );
    vscode.window.showInformationMessage(
      "WaterUI CLI installed successfully (stable)."
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `Failed to install WaterUI CLI (stable). ${message}`
    );
    return false;
  }
}

async function installCliDev(): Promise<boolean> {
  const channel = getOutputChannel();
  channel.show(true);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "waterui-cli-"));
  const repoDir = path.join(tempRoot, "waterui");

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Installing WaterUI CLI (dev)",
      },
      async () => {
        channel.appendLine(
          `> git clone --branch dev --depth 1 https://github.com/water-rs/waterui.git ${repoDir}`
        );
        await runCommandWithOutput(
          "git",
          [
            "clone",
            "--branch",
            "dev",
            "--depth",
            "1",
            "https://github.com/water-rs/waterui.git",
            repoDir,
          ],
          {},
          channel
        );
        const cliDir = path.join(repoDir, "cli");
        channel.appendLine(`> cargo install --path ${cliDir}`);
        await runCommandWithOutput(
          "cargo",
          ["install", "--path", cliDir],
          {},
          channel
        );
      }
    );
    vscode.window.showInformationMessage(
      "WaterUI CLI installed successfully (dev)."
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `Failed to install WaterUI CLI (dev). ${message}`
    );
    return false;
  } finally {
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

function runCommandWithOutput(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  channel: vscode.OutputChannel
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: process.env,
    });

    child.stdout?.on("data", (data) => channel.append(data.toString()));
    child.stderr?.on("data", (data) => channel.append(data.toString()));

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
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
