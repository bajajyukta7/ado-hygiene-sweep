'use strict';

/**
 * Sprint calendar.
 *
 * A work item's iteration tells you whether the team has actually committed to
 * it yet. That matters: a story sitting in a sprint three weeks out has not been
 * groomed because it is not supposed to be groomed yet. Nagging about it teaches
 * people the digest is wrong, and they stop reading it.
 *
 * Phases:
 *   past     the sprint has finished
 *   current  we are inside the sprint window
 *   future   the sprint has not started
 *   none     no sprint assigned (parked at a semester/quarter root)
 */

class SprintCalendar {
  constructor(iterations = []) {
    this.iterations = iterations
      .filter((i) => i.path && i.startDate && i.finishDate)
      .map((i) => ({
        name: i.name,
        path: i.path,
        start: new Date(i.startDate),
        finish: new Date(i.finishDate),
      }))
      .sort((a, b) => a.start - b.start);

    this.byPath = new Map(this.iterations.map((i) => [i.path, i]));
  }

  find(iterationPath) {
    if (!iterationPath) return null;
    return this.byPath.get(iterationPath) || null;
  }

  current(now = new Date()) {
    return this.iterations.find((i) => now >= i.start && now <= i.finish) || null;
  }

  /** Classify an item's iteration relative to now. */
  phase(iterationPath, now = new Date()) {
    const it = this.find(iterationPath);
    if (!it) return 'none';
    if (now > it.finish) return 'past';
    if (now < it.start) return 'future';
    return 'current';
  }

  /**
   * Has the team committed to this work yet?
   *
   * True for the current sprint and anything overdue from a past one. False for
   * future sprints and unscheduled backlog — those are allowed to be rough.
   */
  isCommitted(iterationPath, now = new Date()) {
    const p = this.phase(iterationPath, now);
    return p === 'current' || p === 'past';
  }
}

/** Build a calendar from ADO team iterations, or from a saved fixture. */
function loadCalendar(iterations) {
  return new SprintCalendar(iterations || []);
}

module.exports = { SprintCalendar, loadCalendar };
