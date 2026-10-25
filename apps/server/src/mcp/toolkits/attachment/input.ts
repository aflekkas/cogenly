import { ChatFileAttachment, ChatImageAttachment } from "@cogenly/contracts";
import * as Schema from "effect/Schema";

export const McpAttachmentInput = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
