-- At most one session may be open (closed_at IS NULL) at a time.
-- Prevents the check-then-create race in /api/upload from spawning duplicate
-- open sessions, which made `close` and `active` disagree on "the" session.
-- Partial unique index over a constant: every open row collides on value 1.
CREATE UNIQUE INDEX "Session_one_open_idx" ON "Session" ((1)) WHERE "closed_at" IS NULL;
