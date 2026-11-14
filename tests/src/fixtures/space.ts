/** A space (channel or DM) as `/v1/workspaces/:projectId/spaces` returns it: the fields the flows read. */
export type Space = {
  space_id: string;
  kind: string;
  slug: string | null;
  name: string;
  is_default: boolean;
  archived_at: string | null;
  can_edit: boolean;
  visibility?: 'public' | 'private';
  is_member?: boolean;
};
