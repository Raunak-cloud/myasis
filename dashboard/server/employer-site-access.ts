export function mayRunEmployerSiteApplications(input: {
  targetIsAdmin: boolean;
  initiatedByAdmin: boolean;
  hasIntensiveAllowance: boolean;
  hasFreeEmployerAllowance?: boolean;
}): boolean {
  if (input.targetIsAdmin) return true;
  return input.hasIntensiveAllowance || input.hasFreeEmployerAllowance===true;
}
