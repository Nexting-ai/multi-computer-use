/** Deterministic execute→observe transition, with no additional model turn.
 * Input idempotency remains owned by the executor; this helper never retries. */
export async function executeAndObserve<T extends { surface_id: string }[], V>(
  execute: () => Promise<T>,
  observe: (ids: string[]) => Promise<V[]>,
): Promise<{ deliveries: T; views: V[]; observation_error?: string }> {
  const deliveries = await execute();
  try {
    return {
      deliveries,
      views: await observe([...new Set(deliveries.map((d) => d.surface_id))]),
    };
  } catch (error) {
    return { deliveries, views: [], observation_error: String(error) };
  }
}
