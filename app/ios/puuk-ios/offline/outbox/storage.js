const schema = [
  `CREATE TABLE IF NOT EXISTS outbox_rating (
    owner TEXT NOT NULL, track_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    rating TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY (owner, track_id)
  )`,
  `CREATE TABLE IF NOT EXISTS outbox_rating_projection (
    owner TEXT NOT NULL, track_id TEXT NOT NULL, track TEXT,
    PRIMARY KEY (owner, track_id)
  )`,
  `CREATE TABLE IF NOT EXISTS outbox_rating_snapshot (
    owner TEXT PRIMARY KEY, favorites TEXT NOT NULL, dislikes TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS outbox_entry (
    sequence INTEGER PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
    event_id TEXT NOT NULL, track_id TEXT NOT NULL, body TEXT NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL DEFAULT 0, UNIQUE (owner, kind, event_id)
  )`,
  'CREATE INDEX IF NOT EXISTS outbox_entry_track ON outbox_entry(owner, kind, track_id, sequence)',
  `CREATE TABLE IF NOT EXISTS outbox_cooldown (
    owner TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL,
    PRIMARY KEY (owner, kind)
  )`,
];

const eligible = `FROM outbox_entry e
  LEFT JOIN outbox_cooldown c ON c.owner=e.owner AND c.kind=e.kind
  WHERE e.owner=? AND (e.kind<>'rating' OR NOT EXISTS (
    SELECT 1 FROM outbox_entry old
    WHERE old.owner=e.owner AND old.kind=e.kind AND old.track_id=e.track_id
      AND old.sequence<e.sequence
  ))`;
const dueAt = 'max(e.due_at, coalesce(c.due_at,0))';
const ratingColumns = 'rating, revision, state, operation_id AS operationId';
const MAX_LISTENING_ENTRIES = 10000;

export function createSQLiteOutboxStorage({ transaction }) {
  let initialized = false;
  const transact = async (session, work) => {
    const owner = JSON.stringify([session.owner.origin, session.owner.userId]);
    const result = await transaction(session, (sql) => {
      if (!initialized) schema.forEach((statement) => sql.runSync(statement));
      return work(sql, owner);
    });
    initialized = true;
    return result;
  };

  return {
    listRatingOverlay: (session) =>
      transact(session, (sql, owner) =>
        sql
          .getAllSync(
            `SELECT track_id AS trackId, ${ratingColumns}, p.track
          FROM outbox_rating r LEFT JOIN outbox_rating_projection p USING (owner, track_id)
          WHERE r.owner=? AND (p.track_id IS NOT NULL OR r.state='pending')`,
            owner,
          )
          .map((row) => ({
            ...row,
            track: row.track && JSON.parse(row.track),
          })),
      ),

    readRatingSnapshot: (session) =>
      transact(session, (sql, owner) => {
        const snapshot = sql.getFirstSync(
          'SELECT favorites, dislikes FROM outbox_rating_snapshot WHERE owner=?',
          owner,
        );
        return (
          snapshot && {
            favoriteIds: JSON.parse(snapshot.favorites),
            dislikes: JSON.parse(snapshot.dislikes),
          }
        );
      }),

    reconcileRatings: (session, ratings, favoriteIds, dislikes) =>
      transact(session, (sql, owner) => {
        sql.runSync(
          'INSERT OR REPLACE INTO outbox_rating_snapshot VALUES (?,?,?)',
          owner,
          JSON.stringify(favoriteIds),
          JSON.stringify(dislikes),
        );
        for (const { trackId, operationId } of ratings) {
          sql.runSync(
            `DELETE FROM outbox_rating_projection WHERE owner=? AND track_id=?
            AND EXISTS (SELECT 1 FROM outbox_rating WHERE owner=? AND track_id=?
              AND operation_id=? AND state<>'pending')`,
            owner,
            trackId,
            owner,
            trackId,
            operationId,
          );
        }
      }),

    getRating: (session, trackId) =>
      transact(
        session,
        (sql, owner) =>
          sql.getFirstSync(
            `SELECT ${ratingColumns} FROM outbox_rating WHERE owner=? AND track_id=?`,
            owner,
            trackId,
          ) ?? null,
      ),

    setRating: (session, job) =>
      transact(session, (sql, owner) => {
        sql.runSync(
          `INSERT INTO outbox_rating_projection VALUES (?,?,?)
          ON CONFLICT(owner,track_id) DO UPDATE SET
          track=coalesce(excluded.track, outbox_rating_projection.track)`,
          owner,
          job.trackId,
          job.track ? JSON.stringify(job.track) : null,
        );
        sql.runSync(
          `DELETE FROM outbox_entry WHERE owner=? AND kind='rating'
        AND track_id=? AND claimed=0`,
          owner,
          job.trackId,
        );
        sql.runSync(
          `INSERT INTO outbox_rating VALUES (?,?,?,?,1,'pending')
        ON CONFLICT(owner,track_id) DO UPDATE SET
          operation_id=excluded.operation_id, rating=excluded.rating,
          revision=outbox_rating.revision+1, state='pending'`,
          owner,
          job.trackId,
          job.eventId,
          job.body.rating,
        );
        sql.runSync(
          `INSERT INTO outbox_entry(owner,kind,event_id,track_id,body)
        VALUES (?,'rating',?,?,?)`,
          owner,
          job.eventId,
          job.trackId,
          JSON.stringify(job.body),
        );
        return sql.getFirstSync(
          `SELECT ${ratingColumns} FROM outbox_rating
        WHERE owner=? AND track_id=?`,
          owner,
          job.trackId,
        );
      }),

    enqueuePlayback: (session, job) =>
      transact(session, (sql, owner) => {
        const body = JSON.stringify(job.body);
        const existing = sql.getFirstSync(
          `SELECT body, track_id AS trackId FROM outbox_entry
        WHERE owner=? AND kind=? AND event_id=?`,
          owner,
          job.kind,
          job.eventId,
        );
        if (existing) {
          if (existing.trackId !== job.trackId || existing.body !== body)
            throw new Error('Conflicting playback payload');
          return false;
        }
        const { count } = sql.getFirstSync(
          "SELECT count(*) AS count FROM outbox_entry WHERE owner=? AND kind<>'rating'",
          owner,
        );
        if (count >= MAX_LISTENING_ENTRIES)
          throw new Error('Offline playback outbox is full');
        sql.runSync(
          `INSERT INTO outbox_entry(owner,kind,event_id,track_id,body)
        VALUES (?,?,?,?,?)`,
          owner,
          job.kind,
          job.eventId,
          job.trackId,
          body,
        );
        return true;
      }),

    claim: (session, now) =>
      transact(session, (sql, owner) => {
        const row = sql.getFirstSync(
          `SELECT e.sequence, e.kind, e.event_id AS eventId,
        e.track_id AS trackId, e.body, e.attempts ${eligible}
        AND ${dueAt}<=? ORDER BY e.sequence LIMIT 1`,
          owner,
          now,
        );
        if (!row) return null;
        sql.runSync(
          'UPDATE outbox_entry SET claimed=1 WHERE owner=? AND sequence=?',
          owner,
          row.sequence,
        );
        return { ...row, body: JSON.parse(row.body) };
      }),

    nextDueAt: (session) =>
      transact(
        session,
        (sql, owner) =>
          sql.getFirstSync(`SELECT min(${dueAt}) AS dueAt ${eligible}`, owner)
            .dueAt,
      ),

    settle: (session, job, outcome) =>
      transact(session, (sql, owner) => {
        // event_id also fences completion against sequence reuse after a delete.
        const key = [owner, job.sequence, job.eventId];
        if (outcome.state === 'retry') {
          const { changes } = sql.runSync(
            `UPDATE outbox_entry SET attempts=attempts+1, due_at=?
          WHERE owner=? AND sequence=? AND event_id=?`,
            outcome.dueAt,
            ...key,
          );
          if (changes && outcome.rateLimited) {
            sql.runSync(
              `INSERT INTO outbox_cooldown VALUES (?,?,?)
            ON CONFLICT(owner,kind) DO UPDATE SET due_at=max(outbox_cooldown.due_at,excluded.due_at)`,
              owner,
              job.kind,
              outcome.dueAt,
            );
          }
          return;
        }

        const { changes } = sql.runSync(
          `DELETE FROM outbox_entry
        WHERE owner=? AND sequence=? AND event_id=?`,
          ...key,
        );
        if (changes && job.kind === 'rating') {
          sql.runSync(
            `UPDATE outbox_rating SET state=? WHERE owner=? AND track_id=? AND operation_id=?`,
            outcome.state,
            owner,
            job.trackId,
            job.eventId,
          );
        }
      }),
  };
}
