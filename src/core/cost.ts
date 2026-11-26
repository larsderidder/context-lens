/** Sum costs only when every constituent is known. Empty collections cost zero. */
export function sumCosts(costs: Iterable<number | null>): number | null {
  let total = 0;
  for (const cost of costs) {
    if (cost === null) {
      return null;
    }
    total += cost;
  }
  return total;
}
