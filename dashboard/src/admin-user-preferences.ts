/** Read-only, explicitly selected account details; never raw environment/settings. */
export interface AdminPreferenceSection {
  title: string;
  fields: Array<{ label: string; value: string; note?: string }>;
}
