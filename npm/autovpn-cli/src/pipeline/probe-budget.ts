/**
 * Admission control for the streaming speed-test path.
 *
 * The streaming path submits links as the crawl finds them, so it cannot
 * sample a known set the way `sampleAcrossArtifact` does. This gate bounds how
 * many of them reach the probe pool: a link inside the budget is always
 * admitted, and past it the gate keeps every Nth link with N growing as the
 * sweep runs on.
 *
 * The first `budget` links being admitted unconditionally is deliberate. A
 * thin night (fewer links than the budget) must probe every link it has,
 * because the publish floor is decided on how many of them actually pass.
 * When the sweep is much larger than the budget, the stride keeps the measured
 * subset spread across the remainder instead of stopping at the budget.
 */

export interface ProbeGate {
  /** True when this link should be submitted to the probe pool. */
  shouldSubmit(): boolean;
  /** Links admitted so far, including those past the budget. */
  readonly accepted: number;
}

export function createProbeGate(budgetInput: number): ProbeGate {
  const budget = Math.max(0, Math.trunc(Number(budgetInput)) || 0);
  let accepted = 0;
  let skipped = 0;
  return {
    shouldSubmit(): boolean {
      if (budget <= 0) {
        accepted += 1;
        return true;
      }
      if (accepted < budget) {
        accepted += 1;
        return true;
      }
      skipped += 1;
      const stride = Math.max(2, Math.floor(skipped / budget) + 1);
      if (skipped % stride === 0) {
        accepted += 1;
        return true;
      }
      return false;
    },
    get accepted(): number {
      return accepted;
    }
  };
}
