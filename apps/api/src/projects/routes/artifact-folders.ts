import { normalizeProjectGlyph } from "../lib/project-glyph";
import { normalizeProjectIcon } from "../lib/project-icon";
import { createRoute, z } from "@hono/zod-openapi";
import {
  createGalleryFolder,
  listGalleryFolders,
  editGalleryFolder,
  removeGalleryFolder,
} from "../../artifacts/folders";
import type { GalleryFolderRow } from "../../artifacts/folders";
import { auth, errors, json } from "../../openapi";
import { authorizeArtifactCaller } from "../lib/artifact-access";
import { projectsApp } from "../lib/app";

const Params = z.object({ workspaceId: z.string().uuid() });
const FolderParams = Params.extend({ folderId: z.string().uuid() });
const Fields = z.object({
  name: z.string().trim().min(1).max(100),
  icon: z
    .string()
    .max(64)
    .refine((v) => normalizeProjectIcon(v) !== null, "Choose one emoji")
    .transform((v) => normalizeProjectIcon(v)!)
    .nullable()
    .optional(),
  icon_glyph: z
    .object({
      name: z.string().min(1).max(100),
      color: z.string().min(1).max(32),
    })
    .refine(
      (v) => normalizeProjectGlyph(v) !== null,
      "Choose a supported icon and color",
    )
    .transform((v) => normalizeProjectGlyph(v)!)
    .nullable()
    .optional(),
  parent_folder_id: z.string().uuid().nullable().optional(),
});
const Body = Fields.refine((v) => !(v.icon && v.icon_glyph), {
  message: "Choose an emoji or an icon",
});
const PatchBody = Fields.partial().refine((v) => !(v.icon && v.icon_glyph), {
  message: "Choose an emoji or an icon",
});
const Folder = z.object({
  folder_id: z.string(),
  project_id: z.string(),
  parent_folder_id: z.string().nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  icon_glyph: z.object({ name: z.string(), color: z.string() }).nullable(),
  can_manage: z.boolean(),
});
type Row = GalleryFolderRow;
const serialize = (r: Row, userId: string, manage: boolean) => ({
  folder_id: r.folderId,
  project_id: r.projectId,
  parent_folder_id: r.parentFolderId,
  name: r.name,
  icon: r.icon,
  icon_glyph: r.iconGlyph,
  can_manage: manage || r.createdByUserId === userId,
});

export function registerArtifactFolderRoutes() {
  projectsApp.openapi(
    createRoute({
      method: "get",
      path: "/{workspaceId}/artifacts/folders",
      tags: ["artifacts"],
      summary: "List gallery folders",
      ...auth,
      request: { params: Params },
      responses: {
        200: json(z.object({ folders: z.array(Folder) }), "Folders"),
        ...errors(403, 404),
      },
    }),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const access = await authorizeArtifactCaller(c, workspaceId, "read");
      if (!access.ok) return access.response;
      const rows = await listGalleryFolders(workspaceId);
      return c.json(
        {
          folders: rows.map((r) =>
            serialize(r, access.viewer.userId, access.viewer.manageAny),
          ),
        },
        200,
      );
    },
  );
  projectsApp.openapi(
    createRoute({
      method: "post",
      path: "/{workspaceId}/artifacts/folders",
      tags: ["artifacts"],
      summary: "Create a gallery folder",
      ...auth,
      request: {
        params: Params,
        body: {
          required: true,
          content: { "application/json": { schema: Body } },
        },
      },
      responses: { 201: json(Folder, "Folder"), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const access = await authorizeArtifactCaller(c, workspaceId, "write");
      if (!access.ok) return access.response;
      const body = c.req.valid("json");
      const created = await createGalleryFolder(
        workspaceId,
        access.viewer.userId,
        body,
      );
      if (created.status === 404)
        return c.json({ error: "Parent folder not found" }, 404);
      return c.json(
        serialize(created.row, access.viewer.userId, access.viewer.manageAny),
        201,
      );
    },
  );
  for (const method of ["patch", "delete"] as const) {
    projectsApp.openapi(
      createRoute({
        method,
        path: "/{workspaceId}/artifacts/folders/{folderId}",
        tags: ["artifacts"],
        summary:
          method === "patch"
            ? "Rename a gallery folder, change its icon, or move it into another folder"
            : "Delete a gallery folder; its subfolders and artifacts move up one level",
        ...auth,
        request: {
          params: FolderParams,
          ...(method === "patch"
            ? {
                body: {
                  required: true,
                  content: { "application/json": { schema: PatchBody } },
                },
              }
            : {}),
        },
        responses: {
          200: json(
            z.union([Folder, z.object({ deleted: z.literal(true) })]),
            "Updated",
          ),
          ...errors(400, 403, 404, 409),
        },
      }),
      async (c) => {
        const { workspaceId, folderId } = c.req.valid("param");
        const access = await authorizeArtifactCaller(c, workspaceId, "write");
        if (!access.ok) return access.response;
        const actor = {
          userId: access.viewer.userId,
          manageAny: access.viewer.manageAny,
        };
        const result =
          method === "delete"
            ? await removeGalleryFolder(workspaceId, folderId, actor)
            : await editGalleryFolder(
                workspaceId,
                folderId,
                actor,
                PatchBody.parse(await c.req.json()),
              );
        if (result.status === 404)
          return c.json(
            { error: "parent" in result ? "Parent folder not found" : "Folder not found" },
            404,
          );
        if (result.status === 409)
          return c.json({ error: "A folder cannot move into itself or one of its subfolders" }, 409);
        if (result.status === 403)
          return c.json({ error: "You cannot manage this folder" }, 403);
        if (!result.row) return c.json({ deleted: true as const }, 200);
        const updated = result.row;
        return c.json(
          serialize(updated, access.viewer.userId, access.viewer.manageAny),
          200,
        );
      },
    );
  }
}
