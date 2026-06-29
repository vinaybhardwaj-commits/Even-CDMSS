/**
 * lib/room-rent.ts — wired room-rent loader (VS.2).
 * Loads data/room-rent.json and exposes the avoidable-bed-day cost estimator used by
 * the Care-Value Scorecard's Cost domain. See lib/room-rent-core.ts for the pure logic.
 */
import ROOM_RENT from '@/data/room-rent.json';
import { computeBedDayCost, type RoomRentTable, type BedDayCost } from './room-rent-core';
import type { AdminFacts } from './doc-audit-core';

const TABLE = ROOM_RENT as unknown as RoomRentTable;

/** Estimate the avoidable bed-day cost of an over-stay (0 unless an over-stay was flagged). */
export function estimateBedDayCost(adminFacts: AdminFacts | undefined, overStayFlagged: boolean): BedDayCost {
  return computeBedDayCost(adminFacts?.lengthOfStayDays ?? null, adminFacts?.careSetting ?? null, overStayFlagged, TABLE);
}
