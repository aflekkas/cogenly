import {
  DesktopCliCommandChangeResult,
  DesktopCliCommandInstallInput,
  DesktopCliCommandStateSchema,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopCliCommand from "../../app/DesktopCliCommand.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getCliCommandState = makeIpcMethod({
  channel: IpcChannels.CLI_COMMAND_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopCliCommandStateSchema,
  handler: Effect.fn("desktop.ipc.cliCommand.getState")(function* () {
    return yield* (yield* DesktopCliCommand.DesktopCliCommand).state;
  }),
});

export const installCliCommand = makeIpcMethod({
  channel: IpcChannels.CLI_COMMAND_INSTALL_CHANNEL,
  payload: DesktopCliCommandInstallInput,
  result: DesktopCliCommandChangeResult,
  handler: Effect.fn("desktop.ipc.cliCommand.install")(function* (input) {
    const cliCommand = yield* DesktopCliCommand.DesktopCliCommand;
    return yield* DesktopCliCommand.toChangeResult(cliCommand, cliCommand.install(input));
  }),
});

export const uninstallCliCommand = makeIpcMethod({
  channel: IpcChannels.CLI_COMMAND_UNINSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopCliCommandChangeResult,
  handler: Effect.fn("desktop.ipc.cliCommand.uninstall")(function* () {
    const cliCommand = yield* DesktopCliCommand.DesktopCliCommand;
    return yield* DesktopCliCommand.toChangeResult(cliCommand, cliCommand.uninstall);
  }),
});
