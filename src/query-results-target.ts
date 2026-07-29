export type QueryResultsTarget = 'sqltools' | 'kdbPanel';

type QueryExecutor = () => unknown | PromiseLike<unknown>;

export async function executeForResultsTarget(
  target: QueryResultsTarget,
  executeInSqltools: QueryExecutor,
  executeInKdbPanel: QueryExecutor
): Promise<void> {
  if (target === 'sqltools') {
    await executeInSqltools();
    return;
  }

  await executeInKdbPanel();
}
