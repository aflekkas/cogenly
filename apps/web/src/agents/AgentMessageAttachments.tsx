import type { EnvironmentId } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { FileIcon } from "lucide-react";
import { useMemo } from "react";
import { useAssetUrls } from "~/assets/assetUrls";
import { selectMessageImageResources } from "~/session-logic";
import { isImageAttachment, type ChatAttachment } from "~/types";

/**
 * The images and files a text carried, above its words. Stored images load through
 * signed asset URLs; an optimistic send shows its local preview until then.
 */
export function AgentMessageAttachments({
  environmentId,
  attachments,
}: {
  environmentId: EnvironmentId;
  attachments: ReadonlyArray<ChatAttachment>;
}) {
  const resources = useMemo(() => selectMessageImageResources(attachments), [attachments]);
  const urls = useAssetUrls(environmentId, resources);
  const urlById = new Map<string, string | null>(
    resources.map((resource, index) => [resource.attachmentId, urls[index] ?? null]),
  );
  return (
    <div className="mb-1.5 flex max-w-full flex-wrap gap-1.5 whitespace-normal">
      {attachments.map((attachment) => {
        if (isImageAttachment(attachment)) {
          const src = urlById.get(attachment.id) ?? attachment.previewUrl ?? null;
          return src ? (
            <img
              key={attachment.id}
              src={src}
              alt={attachment.name}
              className="max-h-48 max-w-full rounded-xl object-cover"
            />
          ) : (
            <span
              key={attachment.id}
              className="flex size-16 items-center justify-center rounded-xl bg-background/40 px-1 text-center text-3xs"
            >
              {attachment.name}
            </span>
          );
        }
        return (
          <span
            key={attachment.id}
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg bg-background/40 px-2 py-1 text-xs"
          >
            <FileIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{attachment.name}</span>
            <span className="shrink-0 opacity-70">
              {formatAttachmentSize(attachment.sizeBytes)}
            </span>
          </span>
        );
      })}
    </div>
  );
}
