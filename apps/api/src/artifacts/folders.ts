import { artifactFolders, artifacts } from "@kortix/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../shared/db";

export type GalleryFolderRow = typeof artifactFolders.$inferSelect;
type Input = {
  name: string;
  icon?: string | null;
  icon_glyph?: { name: string; color: string } | null;
  /** The folder this one sits in; null or absent: the gallery root. */
  parent_folder_id?: string | null;
};
type Actor = { userId: string; manageAny: boolean };
type Result =
  | { status: 200; row?: GalleryFolderRow }
  | { status: 403 }
  | { status: 404; parent?: true }
  | { status: 409 };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serializes every change to one project's folder tree. Two concurrent moves
 * (A into B, B into A) each see a valid tree alone; one lock per project makes
 * the second see the first and refuse the cycle.
 */
const lockTree = (tx: Tx, projectId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`artifact_folders:${projectId}`}))`);

/** Folder ids from `startId` up to the root. Bounded: a corrupt tree cannot loop. */
async function ancestry(tx: Tx, projectId: string, startId: string) {
  const rows = await tx
    .select({ id: artifactFolders.folderId, parent: artifactFolders.parentFolderId })
    .from(artifactFolders)
    .where(eq(artifactFolders.projectId, projectId));
  const parentOf = new Map(rows.map((r) => [r.id, r.parent]));
  if (!parentOf.has(startId)) return null;
  const chain: string[] = [];
  for (let id: string | null | undefined = startId; id && chain.length <= rows.length; id = parentOf.get(id)) chain.push(id);
  return chain;
}

export function listGalleryFolders(projectId: string) {
  return db
    .select()
    .from(artifactFolders)
    .where(eq(artifactFolders.projectId, projectId))
    .orderBy(asc(artifactFolders.name));
}
export async function createGalleryFolder(
  projectId: string,
  userId: string,
  input: Input,
): Promise<{ status: 201; row: GalleryFolderRow } | { status: 404; parent: true }> {
  return db.transaction(async (tx) => {
    if (input.parent_folder_id) {
      await lockTree(tx, projectId);
      if (!(await ancestry(tx, projectId, input.parent_folder_id))) return { status: 404, parent: true };
    }
    const [row] = await tx
      .insert(artifactFolders)
      .values({
        projectId,
        parentFolderId: input.parent_folder_id ?? null,
        name: input.name,
        icon: input.icon,
        iconGlyph: input.icon_glyph,
        createdByUserId: userId,
      })
      .returning();
    return { status: 201, row: row! };
  });
}
async function change(
  projectId: string,
  folderId: string,
  actor: Actor,
  input?: Partial<Input>,
): Promise<Result> {
  const where = and(
    eq(artifactFolders.projectId, projectId),
    eq(artifactFolders.folderId, folderId),
  );
  return db.transaction(async (tx) => {
    const reshapes = !input || input.parent_folder_id !== undefined;
    if (reshapes) await lockTree(tx, projectId);
    const [row] = await tx
      .select()
      .from(artifactFolders)
      .where(where)
      .for("update");
    if (!row) return { status: 404 };
    if (row.createdByUserId !== actor.userId && !actor.manageAny)
      return { status: 403 };
    if (!input) {
      // Its subfolders and artifacts move up one level: deleting a folder never
      // hides anything. Files paths and sharing stay intact.
      await tx
        .update(artifactFolders)
        .set({ parentFolderId: row.parentFolderId })
        .where(and(eq(artifactFolders.projectId, projectId), eq(artifactFolders.parentFolderId, folderId)));
      await tx
        .update(artifacts)
        .set({ galleryFolderId: row.parentFolderId })
        .where(and(eq(artifacts.projectId, projectId), eq(artifacts.galleryFolderId, folderId)));
      await tx.delete(artifactFolders).where(where);
      return { status: 200 };
    }
    if (input.parent_folder_id) {
      const chain = await ancestry(tx, projectId, input.parent_folder_id);
      if (!chain) return { status: 404, parent: true };
      // Into itself or one of its own subfolders: the folder would leave the tree.
      if (chain.includes(folderId)) return { status: 409 };
    }
    const [updated] = await tx
      .update(artifactFolders)
      .set({
        name: input.name ?? row.name,
        ...(input.parent_folder_id !== undefined ? { parentFolderId: input.parent_folder_id } : {}),
        ...(input.icon !== undefined
          ? { icon: input.icon, ...(input.icon ? { iconGlyph: null } : {}) }
          : {}),
        ...(input.icon_glyph !== undefined
          ? {
              iconGlyph: input.icon_glyph,
              ...(input.icon_glyph ? { icon: null } : {}),
            }
          : {}),
      })
      .where(where)
      .returning();
    return { status: 200, row: updated! };
  });
}
export const editGalleryFolder = (
  projectId: string,
  folderId: string,
  actor: Actor,
  input: Partial<Input>,
) => change(projectId, folderId, actor, input);
export const removeGalleryFolder = (
  projectId: string,
  folderId: string,
  actor: Actor,
) => change(projectId, folderId, actor);
