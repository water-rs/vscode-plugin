import * as vscode from "vscode";
import * as path from "path";

const TAPLO_EXTENSION_ID = "tamasfe.even-better-toml";
const ASSOCIATION_KEY = "evenBetterToml.schema.associations";
const SCHEMA_FILENAME = "water.toml.schema.json";

/// Associates the bundled Water.toml JSON schema with Taplo (Even Better
/// TOML), so `Water.toml` gets completion and validation when that extension
/// is installed. Other TOML tooling can point at the same schema file.
export async function registerWaterTomlSchema(
  context: vscode.ExtensionContext
): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("waterui")
    .get<boolean>("tomlSchema.enabled", true);
  if (!enabled) {
    return;
  }
  if (!vscode.extensions.getExtension(TAPLO_EXTENSION_ID)) {
    return;
  }

  const schemaUri = vscode.Uri.file(
    path.join(context.extensionPath, "schemas", SCHEMA_FILENAME)
  );
  const config = vscode.workspace.getConfiguration();
  const associations =
    config.get<Record<string, string | string[]>>(ASSOCIATION_KEY) ?? {};

  const key = schemaUri.toString();
  const existing = associations[key];
  const patterns = Array.isArray(existing)
    ? existing
    : existing
      ? [existing]
      : [];
  const wants = ["Water.toml", "**/Water.toml"];
  const missing = wants.filter((pattern) => !patterns.includes(pattern));
  if (!missing.length) {
    return;
  }
  associations[key] = [...patterns, ...missing];
  await config.update(
    ASSOCIATION_KEY,
    associations,
    vscode.ConfigurationTarget.Global
  );
}
