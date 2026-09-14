import * as vscode from "vscode";
import { execFile, spawn, SpawnOptionsWithoutStdio } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";
import { getOutputChannel } from "./output";

const execFileAsync = promisify(execFile);

export function getCliPath(): string {
  const configuration = vscode.workspace.getConfiguration("waterui");
  const cliPath = configuration.get<string>("cliPath")?.trim();
  return cliPath && cliPath.length > 0 ? cliPath : "water";
}

export async function execWater(
  args: string[],
  cwd?: string
): Promise<string> {
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

export async function ensureWaterCliAvailable(): Promise<boolean> {
  try {
    await execWater(["--version"]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(message);
    return false;
  }
}

export function runCliInTerminal(
  name: string,
  args: string[],
  cwd?: string
): void {
  const cliPath = getCliPath();
  const command = [quoteArg(cliPath), ...args.map(quoteArg)].join(" ");
  const terminal = vscode.window.createTerminal({ name, cwd });
  terminal.show(true);
  terminal.sendText(command, true);
}

export function quoteArg(value: string): string {
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

export function isCliRequiredMessage(message: string): boolean {
  return message.toLowerCase().includes("waterui cli is required");
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
