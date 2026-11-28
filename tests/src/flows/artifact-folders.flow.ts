import { flow } from "../core/flow";

const LIST = "/v1/workspaces/:projectId/artifacts/folders";
const ONE = `${LIST}/:folderId`;

type Folder = {
  folder_id: string;
  parent_folder_id: string | null;
  name: string;
  icon: string | null;
  icon_glyph: { name: string; color: string } | null;
  can_manage: boolean;
};

flow(
  "ART-4",
  {
    domain: "artifacts",
    requires: ["database"],
    timeoutMs: 60_000,
    routes: [`GET ${LIST}`, `POST ${LIST}`, `PATCH ${ONE}`, `DELETE ${ONE}`],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember("member");
    await team.grantProjectRole(project.id, member.userId!, "user");
    const owner = ctx.client.as(ctx.P.OWNER);
    const reader = ctx.client.as(member);
    const params = { projectId: project.id };
    let folder: Folder;
    await ctx.step(
      "authentication and input validation reject unauthorized or invalid folder writes",
      async () => {
        (await ctx.client.as(ctx.P.ANON).get(LIST, { params })).status(401);
        (await owner.post(LIST, { name: "  " }, { params })).status(400);
        (
          await owner.post(
            LIST,
            { name: "Assets", icon: "plain text" },
            { params },
          )
        ).status(400);
        (
          await owner.post(
            LIST,
            {
              name: "Assets",
              icon_glyph: { name: "MissingGlyph", color: "#EB5757" },
            },
            { params },
          )
        ).status(400);
      },
    );
    await ctx.step(
      "create a folder with an emoji and read its persisted name and icon",
      async () => {
        folder = (
          await owner.post(
            LIST,
            { name: "Launch assets", icon: "🚀" },
            { params },
          )
        )
          .status(201)
          .json<Folder>();
        if (
          folder.name !== "Launch assets" ||
          folder.icon !== "🚀" ||
          !folder.can_manage
        )
          throw new Error("Folder create response differs");
        const rows = (await reader.get(LIST, { params }))
          .status(200)
          .json<{ folders: Folder[] }>().folders;
        const visible = rows.find((f) => f.folder_id === folder.folder_id);
        if (!visible || visible.can_manage || visible.icon !== "🚀")
          throw new Error("Folder visibility or management permission differs");
      },
    );
    await ctx.step(
      "another member cannot rename or delete the folder; another workspace cannot address it",
      async () => {
        const p = { ...params, folderId: folder.folder_id };
        (await reader.patch(ONE, { name: "Changed" }, { params: p })).status(
          403,
        );
        (await reader.del(ONE, { params: p })).status(403);
        const other = await ctx.fixtures.project();
        (
          await owner.patch(
            ONE,
            { name: "Changed" },
            { params: { projectId: other.id, folderId: folder.folder_id } },
          )
        ).status(404);
      },
    );
    await ctx.step(
      "rename and replace the emoji with a workspace icon, then delete and read back an empty list",
      async () => {
        const p = { ...params, folderId: folder.folder_id };
        (
          await owner.patch(
            ONE,
            {
              name: "Release assets",
              icon: null,
              icon_glyph: { name: "Rocket", color: "#EB5757" },
            },
            { params: p },
          )
        )
          .status(200)
          .body()
          .has("$.name", "Release assets")
          .has("$.icon", null)
          .has("$.icon_glyph.name", "Rocket").has("$.icon_glyph.color", "#eb5757");
        (await owner.patch(ONE, { name: "Archived assets" }, { params: p }))
          .status(200)
          .body()
          .has("$.icon_glyph.name", "Rocket").has("$.icon_glyph.color", "#eb5757");
        (await owner.patch(ONE, { icon: "📁" }, { params: p }))
          .status(200)
          .body()
          .has("$.name", "Archived assets")
          .has("$.icon_glyph", null)
          .has("$.icon", "📁");
        (await owner.del(ONE, { params: p }))
          .status(200)
          .body()
          .has("$.deleted", true);
        (await owner.get(LIST, { params }))
          .status(200)
          .body()
          .has("$.folders", []);
        (await owner.del(ONE, { params: p })).status(404);
      },
    );
    await ctx.step(
      "nest a folder, refuse a missing or foreign parent and every cycle, then delete the parent and read its subfolder one level up",
      async () => {
        const create = (body: Record<string, unknown>) => owner.post(LIST, body, { params });
        const parent = (await create({ name: "Campaigns" })).status(201).json<Folder>();
        if (parent.parent_folder_id !== null) throw new Error("A root folder has a parent");
        const child = (await create({ name: "Q4", parent_folder_id: parent.folder_id }))
          .status(201)
          .json<Folder>();
        if (child.parent_folder_id !== parent.folder_id) throw new Error("Subfolder parent differs");
        (await create({ name: "Lost", parent_folder_id: crypto.randomUUID() })).status(404);
        const other = await ctx.fixtures.project();
        const foreign = (await owner.post(LIST, { name: "Elsewhere" }, { params: { projectId: other.id } }))
          .status(201)
          .json<Folder>();
        (await create({ name: "Cross", parent_folder_id: foreign.folder_id })).status(404);
        const one = (folderId: string) => ({ params: { ...params, folderId } });
        (await owner.patch(ONE, { parent_folder_id: parent.folder_id }, one(parent.folder_id))).status(409);
        (await owner.patch(ONE, { parent_folder_id: child.folder_id }, one(parent.folder_id))).status(409);
        (await reader.patch(ONE, { parent_folder_id: null }, one(child.folder_id))).status(403);
        (await owner.patch(ONE, { parent_folder_id: null }, one(child.folder_id)))
          .status(200)
          .body()
          .has("$.parent_folder_id", null)
          .has("$.name", "Q4");
        (await owner.patch(ONE, { parent_folder_id: parent.folder_id }, one(child.folder_id)))
          .status(200)
          .body()
          .has("$.parent_folder_id", parent.folder_id);
        (await owner.del(ONE, one(parent.folder_id))).status(200);
        const rows = (await owner.get(LIST, { params })).status(200).json<{ folders: Folder[] }>().folders;
        if (rows.length !== 1 || rows[0]!.folder_id !== child.folder_id || rows[0]!.parent_folder_id !== null)
          throw new Error("The subfolder did not move up to the root");
        (await owner.del(ONE, one(child.folder_id))).status(200);
      },
    );
  },
);
