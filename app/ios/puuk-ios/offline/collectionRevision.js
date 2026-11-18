// Kept after a collection is removed so a late response cannot match a new snapshot.
export function nextCollectionRevision(db, owner, kind, id) {
  db.runSync(`CREATE TABLE IF NOT EXISTS collection_revision (
    owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(owner, kind, id)
  )`);
  const old = db.getFirstSync(
    'SELECT updated_at FROM collection WHERE owner=? AND kind=? AND id=?',
    owner,
    kind,
    id,
  );
  db.runSync(
    `INSERT INTO collection_revision VALUES (?,?,?,?)
    ON CONFLICT(owner, kind, id) DO UPDATE SET revision=max(collection_revision.revision+1, excluded.revision)`,
    owner,
    kind,
    id,
    Math.max(Date.now(), (old?.updated_at || 0) + 1),
  );
  return db.getFirstSync(
    'SELECT revision FROM collection_revision WHERE owner=? AND kind=? AND id=?',
    owner,
    kind,
    id,
  ).revision;
}
