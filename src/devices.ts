import * as vscode from "vscode";
import { execWater, isCliRequiredMessage } from "./cli";

export type DevicePlatform =
  | "ios"
  | "android"
  | "macos"
  | "esp32"
  | "linux"
  | "windows"
  | "web";

export interface DeviceInfo {
  platform: DevicePlatform;
  name: string;
  identifier: string;
  kind: "simulator" | "device" | "emulator" | "host" | "board";
  state?: string;
  detail?: string;
}

interface IosDeviceJson {
  name: string;
  udid: string;
  state?: string;
  available?: boolean;
}

interface AndroidDeviceEntryJson {
  name?: string;
  id?: string;
  serial?: string;
  avd?: string;
  state?: string;
  model?: string;
}

interface MacosDeviceJson {
  id: string;
  name: string;
}

interface Esp32DeviceJson {
  port: string;
  likely_esp?: boolean;
}

interface DevicesJsonOutput {
  type?: string;
  platform?: string;
  ios?: IosDeviceJson[];
  android?: {
    emulators?: AndroidDeviceEntryJson[];
    devices?: AndroidDeviceEntryJson[];
  };
  macos?: MacosDeviceJson[];
  esp32?: Esp32DeviceJson[];
}

export interface Destination {
  platform: DevicePlatform;
  label: string;
  deviceId?: string;
}

const DESTINATION_KEY = "waterui.destination";

function flattenDevices(parsed: DevicesJsonOutput): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const entry of parsed.ios ?? []) {
    if (entry.available === false) {
      continue;
    }
    devices.push({
      platform: "ios",
      name: entry.name,
      identifier: entry.udid,
      kind: "simulator",
      state: entry.state,
    });
  }
  const android = parsed.android;
  for (const entry of android?.emulators ?? []) {
    const name = entry.name ?? entry.avd ?? entry.id ?? "Android emulator";
    devices.push({
      platform: "android",
      name,
      identifier: entry.id ?? entry.avd ?? entry.name ?? name,
      kind: "emulator",
      state: entry.state,
      detail: entry.model,
    });
  }
  for (const entry of android?.devices ?? []) {
    const name = entry.name ?? entry.model ?? entry.serial ?? "Android device";
    devices.push({
      platform: "android",
      name,
      identifier: entry.serial ?? entry.id ?? name,
      kind: "device",
      state: entry.state,
      detail: entry.model,
    });
  }
  for (const entry of parsed.macos ?? []) {
    devices.push({
      platform: "macos",
      name: entry.name,
      identifier: entry.id,
      kind: "host",
    });
  }
  for (const entry of parsed.esp32 ?? []) {
    devices.push({
      platform: "esp32",
      name: entry.port,
      identifier: entry.port,
      kind: "board",
      state: entry.likely_esp ? "likely ESP" : undefined,
    });
  }
  return devices;
}

let devicesCache: { at: number; devices: DeviceInfo[] } | undefined;
const DEVICES_CACHE_TTL_MS = 60_000;

/// `water devices --json` enumerates simulators/emulators and can take tens of
/// seconds; callers that just need "the list" share a short-lived cache.
export async function fetchDevices(
  forceRefresh = false
): Promise<DeviceInfo[]> {
  if (
    !forceRefresh &&
    devicesCache &&
    Date.now() - devicesCache.at < DEVICES_CACHE_TTL_MS
  ) {
    return devicesCache.devices;
  }
  const stdout = await execWater(["--json", "devices"]);
  let devices: DeviceInfo[];
  try {
    const parsed = JSON.parse(stdout.trim() || "{}") as
      | DevicesJsonOutput
      | DeviceInfo[];
    devices = Array.isArray(parsed) ? parsed : flattenDevices(parsed);
  } catch (error) {
    throw new Error(
      `Unable to parse CLI response: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  devicesCache = { at: Date.now(), devices };
  return devices;
}

interface DeviceQuickPickItem extends vscode.QuickPickItem {
  device: DeviceInfo | null;
}

export async function promptForDevice(
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

function destinationIcon(destination: Destination): string {
  switch (destination.platform) {
    case "ios":
      return "$(device-mobile)";
    case "android":
      return "$(device-mobile)";
    case "esp32":
      return "$(circuit-board)";
    case "web":
      return "$(globe)";
    default:
      return "$(device-desktop)";
  }
}

/// The status-bar run destination, persisted per workspace.
///
/// `waterui.run` consumes the stored destination; picking a new one is one
/// command (`waterui.destination.pick`) instead of a per-run prompt.
export class DestinationPicker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private destination: Destination | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      90
    );
    this.item.command = "waterui.destination.pick";
    this.destination = context.workspaceState.get<Destination>(DESTINATION_KEY);
    this.refresh();
    this.item.show();
  }

  current(): Destination | undefined {
    return this.destination;
  }

  async pick(): Promise<void> {
    let devices: DeviceInfo[];
    try {
      devices = await vscode.window.withProgress<DeviceInfo[]>(
        {
          location: vscode.ProgressLocation.Window,
          title: "Querying WaterUI devices...",
        },
        async () => fetchDevices()
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isCliRequiredMessage(message)) {
        vscode.window.showErrorMessage(message);
        return;
      }
      devices = [];
    }

    interface DestinationPickItem extends vscode.QuickPickItem {
      destination?: Destination;
    }

    const items: DestinationPickItem[] = [
      {
        label: "$(sync) Automatic",
        description: "Let WaterUI choose per run",
        destination: undefined,
      },
      ...devices.map((device) => ({
        label: device.name,
        description: `${device.platform} • ${device.kind}`,
        detail:
          [device.identifier, device.state, device.detail]
            .filter(Boolean)
            .join(" | ") || undefined,
        destination: {
          platform: device.platform,
          label: device.name,
          deviceId: device.identifier,
        } as Destination,
      })),
    ];

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: "Select the WaterUI run destination",
    });
    if (selection === undefined) {
      return;
    }
    this.destination = selection.destination;
    await this.context.workspaceState.update(
      DESTINATION_KEY,
      this.destination ?? null
    );
    this.refresh();
  }

  private refresh(): void {
    if (this.destination) {
      this.item.text = `${destinationIcon(this.destination)} ${
        this.destination.label
      }`;
      this.item.tooltip = `WaterUI destination: ${this.destination.label} (click to change)`;
    } else {
      this.item.text = "$(sync) WaterUI: Auto";
      this.item.tooltip =
        "WaterUI run destination: automatic (click to choose)";
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
