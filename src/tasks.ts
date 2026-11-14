import * as vscode from "vscode";
import { getCliPath, quoteArg } from "./cli";

export const WATERUI_TASK_TYPE = "waterui";

interface WaterUITaskDefinition extends vscode.TaskDefinition {
  type: typeof WATERUI_TASK_TYPE;
  command: "run" | "package" | "preview" | "test" | "doctor" | "devices";
  platform?: string;
  backend?: string;
  device?: string;
  release?: boolean;
  target?: string;
  args?: string[];
}

/// `type: "waterui"` tasks in tasks.json — one definition maps onto one
/// `water` invocation so F5-bound tasks can build/run without wrapping the CLI
/// in shell commands.
export class WaterUITaskProvider implements vscode.TaskProvider {
  provideTasks(): vscode.Task[] {
    return [
      this.task({ type: WATERUI_TASK_TYPE, command: "run" }, "WaterUI: Run"),
      this.task(
        { type: WATERUI_TASK_TYPE, command: "package", release: true },
        "WaterUI: Package (release)"
      ),
    ];
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const definition = task.definition as WaterUITaskDefinition;
    if (definition.type !== WATERUI_TASK_TYPE || !definition.command) {
      return undefined;
    }
    return this.task(definition, task.name);
  }

  private task(
    definition: WaterUITaskDefinition,
    name: string
  ): vscode.Task {
    const args: string[] = [];
    if (definition.command === "test") {
      args.push("preview", "test");
    } else {
      args.push(definition.command);
    }
    if (definition.target) {
      args.push(definition.target);
    }
    if (definition.platform) {
      args.push("--platform", definition.platform);
    }
    if (definition.backend) {
      args.push("--backend", definition.backend);
    }
    if (definition.device) {
      args.push("--device", definition.device);
    }
    if (definition.release) {
      args.push("--release");
    }
    if (definition.args) {
      args.push(...definition.args);
    }

    const scope =
      taskScopeFolder() ?? vscode.TaskScope.Workspace;
    const commandLine = [quoteArg(getCliPath()), ...args.map(quoteArg)].join(
      " "
    );
    const task = new vscode.Task(
      definition,
      scope,
      name,
      "waterui",
      new vscode.ShellExecution(commandLine),
      []
    );
    task.group =
      definition.command === "run" ? vscode.TaskGroup.Build : undefined;
    return task;
  }
}

function taskScopeFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}
