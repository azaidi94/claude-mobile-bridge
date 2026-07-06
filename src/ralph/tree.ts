/**
 * Pure process-tree collection for the ralph tree-kill. Kept dependency-free so
 * it's unit-testable without dragging in the monitor's IO graph.
 */

/**
 * Collect a process subtree (root + all descendants), depth-first, one pid per
 * entry. Mirrors afk_tasks.sh's `pids_of_tree`. `pgrepFn(pid)` returns the
 * direct children of `pid` (pgrep -P). Inject a fake pgrep in tests.
 */
export async function collectTree(
  rootPid: number,
  pgrepFn: (pid: number) => Promise<number[]>,
): Promise<number[]> {
  const result: number[] = [];
  const visit = async (pid: number): Promise<void> => {
    result.push(pid);
    for (const child of await pgrepFn(pid)) await visit(child);
  };
  await visit(rootPid);
  return result;
}
