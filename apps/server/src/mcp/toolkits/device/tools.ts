import {
  OrchestratorMcpFailure,
  DeviceToolCloseInput,
  DeviceToolError,
  DeviceToolListResult,
  DeviceToolOpenInput,
  DeviceToolOpenResult,
  DeviceSetupStatus,
  DeviceToolSetupInput,
  DeviceToolScreenshotResult,
  DeviceToolTargetInput,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../../../config.ts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  DeviceService.DeviceService,
];

/** What a device tool fails with, including the access gate's refusal. */
const DeviceToolFailure = Schema.Union([DeviceToolError, OrchestratorMcpFailure]);

/**
 * Deliberately a small surface: lifecycle, visibility for the user, and one
 * image-returning verb. Driving the device (taps, typing, install, logs)
 * happens through the preconfigured `agent-device` CLI, which has the
 * semantic snapshot model agents need and stays current with its own
 * releases. Wrapping its commands here would only lag behind it.
 */
const DeviceListTool = Tool.make("device_list", {
  description:
    "List host iOS/Android capabilities, devices and streams open in this thread. Use before device_open when ID is unknown.",
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    hostId: Schema.optional(
      Schema.String.annotate({ description: "Limit to one device host. Defaults to all hosts." }),
    ),
  }),
  success: DeviceToolListResult,
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List devices")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeviceSetupStatusTool = Tool.make("device_setup_status", {
  description:
    "Check device support, installed hosts/platforms and concrete repair steps without starting or installing anything. Relay steps requiring the user; fix other prerequisites with device_setup or terminal.",
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    hostId: Schema.optional(
      Schema.String.annotate({ description: "Limit to one device host. Defaults to all hosts." }),
    ),
  }),
  success: DeviceSetupStatus,
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Device setup status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeviceSetupTool = Tool.make("device_setup", {
  description:
    "Install/repair device hub and agent tools, then recheck platforms; first install may take minutes. Returns device_setup_status report with user-only nextSteps (Xcode/Android SDK).",
  parameters: DeviceToolSetupInput,
  success: DeviceSetupStatus,
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Set up devices")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const DeviceOpenTool = Tool.make("device_open", {
  description:
    "Boot/open a device and stream it in the user's Device panel. Drive with the returned device-pinned agent-device invocation.",
  parameters: DeviceToolOpenInput,
  success: DeviceToolOpenResult,
  failure: DeviceToolFailure,
  dependencies: [...dependencies, FileSystem.FileSystem, Path.Path, ServerConfig.ServerConfig],
})
  .annotate(Tool.Title, "Open device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceScreenshotTool = Tool.make("device_screenshot", {
  description:
    "Capture the current screen of an open device as a PNG image. Use it to see what the user sees; for taps and text use the agent-device CLI.",
  parameters: DeviceToolTargetInput,
  success: DeviceToolScreenshotResult,
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot device")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const DeviceCloseTool = Tool.make("device_close", {
  description:
    "Remove a device from this thread's Device panel. Pass shutdown=true to also power the simulator or emulator off.",
  parameters: DeviceToolCloseInput,
  success: Schema.Record(Schema.String, Schema.Never).annotate({
    description: "The device was closed.",
  }),
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Close device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceStandardToolkit = Toolkit.make(
  DeviceListTool,
  DeviceSetupStatusTool,
  DeviceSetupTool,
  DeviceOpenTool,
  DeviceCloseTool,
);

export const DeviceScreenshotToolkit = Toolkit.make(DeviceScreenshotTool);

export const DeviceToolkit = Toolkit.make(
  DeviceListTool,
  DeviceSetupStatusTool,
  DeviceSetupTool,
  DeviceOpenTool,
  DeviceScreenshotTool,
  DeviceCloseTool,
);
