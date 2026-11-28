// Gallery folder deletion uses this index for the FK SET NULL action.
export const shorthands = undefined;
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`create index concurrently if not exists idx_artifacts_gallery_folder on kortix.artifacts (gallery_folder_id) where gallery_folder_id is not null`);
};
