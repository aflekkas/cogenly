/** Grant refusals from Google's token endpoint, surfaced by workspace-mcp. */
export const isClientRejection = (text: string): boolean =>
  /invalid_client|unauthorized_client/i.test(text);

export const isGrantRejection = (text: string): boolean =>
  /invalid_grant|token has been expired or revoked|google\.auth\.exceptions\.RefreshError/i.test(
    text,
  );
