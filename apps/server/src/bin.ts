/** CLI entry. */
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  if (process.argv[2] === "__document-text" && process.argv[3]) {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]));
    } catch {
      process.exitCode = 2;
    }
  } else {
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
