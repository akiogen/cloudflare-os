// BLOS (business-loop-os ADR-0015): a deployment that serves a Team page outside this app sets
// VITE_TEAM_PAGE_URL at build time, and the profile menus link to it. Unset, nothing is shown.

export function teamPageUrl(): string | undefined {
  return import.meta.env.VITE_TEAM_PAGE_URL?.trim() || undefined
}
