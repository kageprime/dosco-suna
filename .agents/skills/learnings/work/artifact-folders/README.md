---
title: Artifact gallery folders
status: implementation and verification
owner: agent
updated: 2026-11-24
---

# Artifact gallery folders

The artifact gallery is flat. Named folders organize related artifacts without
changing the files, artifact identity, sharing, or existing URLs.

The approved design uses workspace-visible folders that nest (`parent_folder_id`). Each folder
has a name and the existing workspace emoji or named icon. The gallery supports
create, edit, move, and delete. Deleting a folder moves its subfolders and
artifacts up one level. Creating a doc inside a folder assigns that folder. Search and personal
scope filters can find artifacts across folders from the root.

The API owns persistence and permissions. Folder names are visible to workspace
members with artifact read permission. A folder's creator or an artifact manager
can edit or delete it. Moving an artifact requires its existing management
permission. Membership grants no artifact access.

`artifact_folders` holds folder metadata. `artifacts.gallery_folder_id` stores
membership. The nullable foreign key clears membership on folder deletion.
A partial index supports that action. Membership writes hold a key-share lock on
the destination. When deletion wins after a publish writes Files, the publish
finishes at root. Missing destinations on moves return 404. A per-project advisory lock serializes folder-tree
changes, so two crossing moves cannot form a cycle; a move into a folder's own
subtree returns 409.

API routes are in `apps/api/src/projects/routes/artifact-folders.ts`. Queries
live in `apps/api/src/artifacts/folders.ts`. The SDK exposes folder CRUD and
React hooks. The web gallery reuses `ProjectIconField` and `EntityAvatar`.

Verification covers HTTP permissions and validation in `ART-4`, SDK error
propagation, real Files publishing and moving, and browser DOM/network results.
Run targeted tests only. Local evidence belongs in gitignored `output/`.

Physical file movement, folder-level sharing, and mobile folder UI are
outside this feature.
