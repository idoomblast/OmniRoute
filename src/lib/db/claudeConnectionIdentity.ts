// One Claude account reaches its personal workspace and every Team org it belongs
// to; the organization discriminates those connections (#18763). The org decides
// only when both rows carry one, so legacy rows without it still match.
type JsonRecord = Record<string, unknown>;

function organizationOf(value: JsonRecord | null | undefined): string | null {
  const organization = value?.organizationUUID;
  return typeof organization === "string" && organization.trim() ? organization.trim() : null;
}

export function isOtherClaudeOrg(
  incoming: JsonRecord | null | undefined,
  existing: JsonRecord | null | undefined
): boolean {
  const incomingOrganization = organizationOf(incoming);
  if (!incomingOrganization) return false;
  const existingOrganization = organizationOf(existing);
  return existingOrganization !== null && existingOrganization !== incomingOrganization;
}
