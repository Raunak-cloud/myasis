/**
 * Employer-site applications are in operator testing, not customer release.
 *
 * An administrator may test the feature on their own account, or start it for
 * an Intensive account that has the required employer-site allowance. A
 * customer's scheduled run never enables the feature until the launch gate is
 * deliberately changed here.
 */
export function mayRunEmployerSiteApplications(input: {
  targetIsAdmin: boolean;
  initiatedByAdmin: boolean;
  hasIntensiveAllowance: boolean;
}): boolean {
  if (input.targetIsAdmin) return true;
  return input.initiatedByAdmin && input.hasIntensiveAllowance;
}
