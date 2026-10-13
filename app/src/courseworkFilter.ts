import { useState } from 'react';
import type { WorkFilter } from './courseworkRows';

/**
 * The filter on one assignment's class list, remembered while the app is
 * open: opening a student's work and coming back finds the list as it was
 * left, and the list beside the work when grading at a desk shows the same
 * students as the page it came from.
 */
const remembered = new Map<string, WorkFilter>();

export function useWorkFilter(courseworkId: string): [WorkFilter, (filter: WorkFilter) => void] {
  const [filter, setFilter] = useState<WorkFilter>(() => remembered.get(courseworkId) ?? 'all');
  return [
    filter,
    (next) => {
      remembered.set(courseworkId, next);
      setFilter(next);
    },
  ];
}
