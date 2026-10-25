/** The portable name shown to turns and accepted by machine-selecting tools. */
export const normalizeMachineName = (name: string): string => name.trim().replace(/\s+/g, " ");
