import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { promises as fs } from "fs";
import { execWater, runCliInTerminal, getCliPath } from "./cli";
import { getOutputChannel } from "./output";

export interface PreviewTarget {
  symbol: string;
  displayName: string;
  uri: vscode.Uri;
  line: number;
}

const PREVIEW_ATTR = /^\s*#\[\s*preview\s*(?:\([^\]]*\))?\s*\]\s*$/;
const FN_DECL = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/;

/// Finds the `#[preview]`-annotated function following `attrLine`, if any.
function previewFunctionAfter(
  document: vscode.TextDocument,
  attrLine: number
): { name: string; line: number } | undefined {
  for (let line = attrLine + 1; line < Math.min(attrLine + 8, document.lineCount); line++) {
    const text = document.lineAt(line).text;
    if (/^\s*#/.test(text) || /^\s*$/.test(text) || /^\s*\/\//.test(text)) {
      continue;
    }
    const match = FN_DECL.exec(text);
    if (match) {
      return { name: match[1], line };
    }
    return undefined;
  }
  return undefined;
}

async function findCargoToml(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
  let dir = path.dirname(uri.fsPath);
  for (let depth = 0; depth < 8; depth++) {
    const candidate = vscode.Uri.file(path.join(dir, "Cargo.toml"));
    try {
      await fs.access(candidate.fsPath);
      return candidate;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

async function crateName(cargoToml: vscode.Uri): Promise<string | undefined> {
  try {
    const text = await fs.readFile(cargoToml.fsPath, "utf8");
    const match = /^name\s*=\s*"([^"]+)"/m.exec(text);
    return match?.[1]?.replace(/-/g, "_");
  } catch {
    return undefined;
  }
}

/// Best-effort `crate::module::function` path for a preview function.
///
/// The CLI resolves targets by function path suffix; `crate::mod::name` is the
/// canonical spelling used by `waterui_preview_{crate}_{path}`.
export async function previewSymbolFor(
  document: vscode.TextDocument,
  fnName: string
): Promise<string> {
  const cargoToml = await findCargoToml(document.uri);
  if (!cargoToml) {
    return fnName;
  }
  const crate = await crateName(cargoToml);
  const srcDir = path.join(path.dirname(cargoToml.fsPath), "src");
  const filePath = document.uri.fsPath;
  let modulePath = "";
  if (filePath.startsWith(srcDir + path.sep)) {
    const rel = filePath.slice(srcDir.length + 1).replace(/\.rs$/, "");
    if (rel !== "lib" && rel !== "main") {
      modulePath =
        rel
          .split(path.sep)
          .filter((segment) => segment !== "mod")
          .join("::") + "::";
    }
  }
  return `${crate ? crate + "::" : ""}${modulePath}${fnName}`;
}

/// Lists every `#[preview]` function in the workspace's Rust sources.
export async function collectPreviewTargets(): Promise<PreviewTarget[]> {
  const targets: PreviewTarget[] = [];
  const files = await vscode.workspace.findFiles(
    "**/*.rs",
    "{**/target/**,**/.git/**,**/node_modules/**}",
    400
  );
  for (const uri of files) {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      continue;
    }
    for (let line = 0; line < document.lineCount; line++) {
      if (!PREVIEW_ATTR.test(document.lineAt(line).text)) {
        continue;
      }
      const fn = previewFunctionAfter(document, line);
      if (!fn) {
        continue;
      }
      const symbol = await previewSymbolFor(document, fn.name);
      targets.push({
        symbol,
        displayName: fn.name,
        uri,
        line: fn.line,
      });
    }
  }
  return targets;
}

async function findManifestDir(startDir: string): Promise<string | undefined> {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth++) {
    for (const manifest of ["Water.toml", "Cargo.toml"]) {
      try {
        await fs.access(path.join(dir, manifest));
        return dir;
      } catch {
        // keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

async function projectDirFor(
  uri: vscode.Uri | undefined
): Promise<string | undefined> {
  if (uri) {
    const manifestDir = await findManifestDir(path.dirname(uri.fsPath));
    if (manifestDir) {
      return manifestDir;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function previewFrame(): string {
  return (
    vscode.workspace
      .getConfiguration("waterui")
      .get<string>("preview.frame")?.trim() || "375x667"
  );
}

function previewPlatformArgs(): string[] {
  const platform = vscode.workspace
    .getConfiguration("waterui")
    .get<string>("preview.platform")
    ?.trim();
  const backend = vscode.workspace
    .getConfiguration("waterui")
    .get<string>("preview.backend")
    ?.trim();
  const args: string[] = [];
  if (platform) {
    args.push("--platform", platform);
  }
  if (backend) {
    args.push("--backend", backend);
  }
  return args;
}

async function renderPreviewPng(
  target: PreviewTarget
): Promise<{ png: Buffer; stderrNote?: string }> {
  const storage = vscode.Uri.joinPath(
    PreviewPanel.storageRoot,
    `${crypto.createHash("sha1").update(target.symbol).digest("hex")}.png`
  );
  await fs.mkdir(path.dirname(storage.fsPath), { recursive: true });
  const projectDir = (await projectDirFor(target.uri)) ?? ".";
  const args = [
    "preview",
    target.symbol,
    "--path",
    projectDir,
    "--frame",
    previewFrame(),
    "--output",
    storage.fsPath,
    ...previewPlatformArgs(),
  ];
  await execWater(args, projectDir);
  const png = await fs.readFile(storage.fsPath);
  return { png };
}

export class PreviewPanel implements vscode.Disposable {
  static storageRoot: vscode.Uri;
  private static current: PreviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private target: PreviewTarget | undefined;
  private rendering = false;
  private pendingRender = false;
  private webviewReady = false;
  private readonly pendingMessages: unknown[] = [];
  private readonly saveWatcher: vscode.Disposable;
  private readonly disposeBag: vscode.Disposable[] = [];

  static show(
    context: vscode.ExtensionContext,
    target: PreviewTarget | undefined
  ): void {
    PreviewPanel.storageRoot = context.globalStorageUri;
    if (!PreviewPanel.current) {
      PreviewPanel.current = new PreviewPanel(context);
    }
    PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    if (target) {
      PreviewPanel.current.setTarget(target);
    } else {
      void PreviewPanel.current.promptTarget();
    }
  }

  static currentTarget(): PreviewTarget | undefined {
    return PreviewPanel.current?.target;
  }

  static refreshIfVisible(): void {
    PreviewPanel.current?.refresh();
  }

  static promptOnCurrent(): void {
    void PreviewPanel.current?.promptTarget();
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      "wateruiPreview",
      "WaterUI Preview",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.saveWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
      if (!this.target || document.languageId !== "rust") {
        return;
      }
      if (
        vscode.workspace
          .getConfiguration("waterui")
          .get<boolean>("preview.refreshOnSave", true) &&
        this.isInsideProject(document.uri)
      ) {
        this.scheduleRender();
      }
    });
    this.panel.onDidDispose(() => this.dispose(), null, this.disposeBag);
    this.panel.webview.onDidReceiveMessage(
      (message: { command?: string }) => {
        if (message.command === "refresh") {
          this.refresh();
        }
        if (message.command === "ready") {
          this.webviewReady = true;
          while (this.pendingMessages.length) {
            void this.panel.webview.postMessage(this.pendingMessages.shift());
          }
        }
      },
      null,
      this.disposeBag
    );
    this.renderHtml();
  }

  private projectDir: string | undefined;

  private isInsideProject(uri: vscode.Uri): boolean {
    return this.projectDir ? uri.fsPath.startsWith(this.projectDir) : true;
  }

  private renderTimer: NodeJS.Timeout | undefined;

  private scheduleRender(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => this.refresh(), 800);
  }

  async setTarget(target: PreviewTarget): Promise<void> {
    this.target = target;
    this.projectDir = await projectDirFor(target.uri);
    this.panel.title = `Preview: ${target.displayName}`;
    this.renderHtml();
    await this.refresh();
  }

  async promptTarget(): Promise<void> {
    const targets = await vscode.window.withProgress<PreviewTarget[]>(
      {
        location: vscode.ProgressLocation.Window,
        title: "Discovering preview targets...",
      },
      collectPreviewTargets
    );
    if (!targets.length) {
      vscode.window.showInformationMessage(
        "WaterUI: no #[preview] functions found in this workspace."
      );
      return;
    }
    const selection = await vscode.window.showQuickPick(
      targets.map((target) => ({
        label: target.displayName,
        description: target.symbol,
        detail: vscode.workspace.asRelativePath(target.uri),
        target,
      })),
      { placeHolder: "Select a preview target" }
    );
    if (selection) {
      await this.setTarget(selection.target);
    }
  }

  async refresh(): Promise<void> {
    if (!this.target) {
      await this.promptTarget();
      return;
    }
    if (this.rendering) {
      this.pendingRender = true;
      return;
    }
    this.rendering = true;
    this.postStatus("rendering");
    try {
      const started = Date.now();
      const { png } = await renderPreviewPng(this.target);
      this.postImage(png.toString("base64"), Date.now() - started);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postError(message);
    } finally {
      this.rendering = false;
      if (this.pendingRender) {
        this.pendingRender = false;
        void this.refresh();
      }
    }
  }

  private post(message: unknown): void {
    if (this.webviewReady) {
      void this.panel.webview.postMessage(message);
    } else {
      this.pendingMessages.push(message);
    }
  }

  private postStatus(state: "rendering" | "idle"): void {
    this.post({ type: "status", state });
  }

  private postImage(base64: string, elapsedMs: number): void {
    this.post({
      type: "image",
      data: base64,
      elapsedMs,
      target: this.target?.symbol,
      frame: previewFrame(),
    });
  }

  private postError(message: string): void {
    this.post({ type: "error", message });
  }

  private renderHtml(): void {
    const nonce = crypto.randomBytes(16).toString("hex");
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: inherit; }
  .toolbar .target { font-weight: 600; }
  .toolbar .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .toolbar button { margin-left: auto; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  .stage { display: flex; justify-content: center; padding: 24px; }
  img { max-width: 100%; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: #fff; }
  .status { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
  .error { margin: 16px; padding: 12px; border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 6px; color: var(--vscode-errorForeground); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
  .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="toolbar">
  <span class="target" id="target">WaterUI Preview</span>
  <span class="meta" id="meta">select a #[preview] target</span>
  <button id="refresh">Refresh</button>
</div>
<div class="stage" id="stage"><div class="status">Nothing rendered yet.</div></div>
<div id="errorSlot"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ command: 'ready' });
  const stage = document.getElementById('stage');
  const meta = document.getElementById('meta');
  const targetEl = document.getElementById('target');
  const errorSlot = document.getElementById('errorSlot');
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'status' && message.state === 'rendering') {
      meta.innerHTML = '<span class="spinner"></span> rendering…';
    }
    if (message.type === 'image') {
      errorSlot.innerHTML = '';
      targetEl.textContent = message.target ?? 'WaterUI Preview';
      meta.textContent = message.frame + ' · ' + (message.elapsedMs / 1000).toFixed(1) + 's';
      stage.innerHTML = '';
      const img = document.createElement('img');
      img.src = 'data:image/png;base64,' + message.data;
      stage.appendChild(img);
    }
    if (message.type === 'error') {
      meta.textContent = 'render failed';
      errorSlot.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'error';
      box.textContent = message.message;
      errorSlot.appendChild(box);
    }
  });
</script>
</body>
</html>`;
  }

  dispose(): void {
    if (PreviewPanel.current === this) {
      PreviewPanel.current = undefined;
    }
    this.saveWatcher.dispose();
    this.renderTimer && clearTimeout(this.renderTimer);
    for (const item of this.disposeBag) {
      item.dispose();
    }
    this.panel.dispose();
  }
}

/// CodeLens on `#[preview]` functions: run, snapshot, test.
export class PreviewCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (let line = 0; line < document.lineCount; line++) {
      if (!PREVIEW_ATTR.test(document.lineAt(line).text)) {
        continue;
      }
      const fn = previewFunctionAfter(document, line);
      if (!fn) {
        continue;
      }
      const range = new vscode.Range(line, 0, line, 0);
      const uri = document.uri;
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(play) Preview",
          command: "waterui.preview.showFor",
          arguments: [{ uri, fnName: fn.name, line: fn.line }],
        }),
        new vscode.CodeLens(range, {
          title: "$(device-camera) Snapshot",
          command: "waterui.preview.snapshot",
          arguments: [{ uri, fnName: fn.name, line: fn.line }],
        }),
        new vscode.CodeLens(range, {
          title: "$(check) Test",
          command: "waterui.preview.test",
          arguments: [{ uri, fnName: fn.name, line: fn.line }],
        })
      );
    }
    return lenses;
  }
}

interface PreviewCommandArgs {
  uri: vscode.Uri;
  fnName: string;
  line: number;
}

async function targetFromArgs(
  args: PreviewCommandArgs
): Promise<PreviewTarget> {
  const document = await vscode.workspace.openTextDocument(args.uri);
  const symbol = await previewSymbolFor(document, args.fnName);
  return {
    symbol,
    displayName: args.fnName,
    uri: args.uri,
    line: args.line,
  };
}

export function registerPreview(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  PreviewPanel.storageRoot = context.globalStorageUri;
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.languages.registerCodeLensProvider(
      { language: "rust", scheme: "file" },
      new PreviewCodeLensProvider()
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "waterui.preview.showFor",
      async (args: PreviewCommandArgs) => {
        const target = await targetFromArgs(args);
        PreviewPanel.show(context, target);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand("waterui.preview.open", async () => {
      PreviewPanel.show(context, undefined);
    })
  );

  disposables.push(
    vscode.commands.registerCommand("waterui.preview.refresh", () => {
      PreviewPanel.refreshIfVisible();
    })
  );

  disposables.push(
    vscode.commands.registerCommand(
      "waterui.preview.snapshot",
      async (args: PreviewCommandArgs) => {
        const target = await targetFromArgs(args);
        const projectDir = (await projectDirFor(target.uri)) ?? ".";
        const output = vscode.Uri.joinPath(
          context.globalStorageUri,
          `${target.displayName}-snapshot.png`
        );
        await fs.mkdir(path.dirname(output.fsPath), { recursive: true });
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Rendering preview ${target.displayName}...`,
            },
            async () =>
              execWater(
                [
                  "preview",
                  target.symbol,
                  "--path",
                  projectDir,
                  "--frame",
                  previewFrame(),
                  "--output",
                  output.fsPath,
                  ...previewPlatformArgs(),
                ],
                projectDir
              )
          );
          await vscode.commands.executeCommand("vscode.open", output);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(
            `WaterUI preview failed: ${message}`
          );
        }
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "waterui.preview.test",
      async (args: PreviewCommandArgs) => {
        const target = await targetFromArgs(args);
        const projectDir = (await projectDirFor(target.uri)) ?? ".";
        runCliInTerminal(
          "WaterUI Preview Test",
          [
            "preview",
            "test",
            target.symbol,
            "--path",
            projectDir,
            ...previewPlatformArgs(),
          ],
          projectDir
        );
        getOutputChannel().appendLine(
          `> ${getCliPath()} preview test ${target.symbol}`
        );
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "waterui.preview.pickTarget",
      async () => PreviewPanel.promptOnCurrent()
    )
  );

  return disposables;
}
