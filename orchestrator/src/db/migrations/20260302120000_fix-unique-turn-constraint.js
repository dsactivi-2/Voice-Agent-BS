/**
 * Migration: fix unique_turn constraint on turns table.
 *
 * BEFORE: UNIQUE (call_id, turn_number)
 *   → Only one row per turn number, so the user utterance and bot reply
 *     share the same turn_number and one of them is silently dropped.
 *
 * AFTER:  UNIQUE (call_id, turn_number, speaker)
 *   → One row per (call, turn, speaker) — both 'user' and 'bot' rows
 *     for the same turn_number can coexist.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.dropConstraint('turns', 'unique_turn');
  pgm.addConstraint('turns', 'unique_turn', 'UNIQUE (call_id, turn_number, speaker)');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropConstraint('turns', 'unique_turn');
  pgm.addConstraint('turns', 'unique_turn', 'UNIQUE (call_id, turn_number)');
};
