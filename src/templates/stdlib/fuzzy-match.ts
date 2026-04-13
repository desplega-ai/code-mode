/**
 * Emits the `sdks/stdlib/fuzzy-match.ts` seed written into a workspace on init.
 */
export function fuzzyMatchTs(): string {
  return `/**
 * @name fuzzyMatch
 * @description Ranks candidate strings by subsequence-match score against a query and returns the top matches.
 * @tags string, search, utility
 */
export function fuzzyMatch(query: string, candidates: string[], limit?: number): string[] {
  const q = query.toLowerCase();
  const scored: { value: string; score: number }[] = [];
  for (const candidate of candidates) {
    const score = scoreSubsequence(q, candidate.toLowerCase());
    if (score > 0) scored.push({ value: candidate, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = limit === undefined ? scored : scored.slice(0, Math.max(0, limit));
  return top.map((entry) => entry.value);
}

function scoreSubsequence(query: string, target: string): number {
  if (query.length === 0) return 1;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      qi++;
      streak++;
      score += 1 + streak;
    } else {
      streak = 0;
    }
  }
  if (qi < query.length) return 0;
  return score / (target.length + 1);
}
`;
}
