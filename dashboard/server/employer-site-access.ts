export function mayRunEmployerSiteApplications(input: {
  targetIsAdmin: boolean;
  initiatedByAdmin: boolean;
  hasIntensiveAllowance: boolean;
}): boolean {
  if (input.targetIsAdmin) return true;
  return input.hasIntensiveAllowance;
}
