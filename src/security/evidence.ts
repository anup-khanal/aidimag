import type { EvidenceType } from "../types.js";

/** Evidence types that run shell commands on the local machine during verify. */
export const EXECUTABLE_EVIDENCE_TYPES = new Set<EvidenceType>([
  "STATIC_CHECK",
  "TEST_RESULT",
  "EXEC_TRACE",
]);

export function isExecutableEvidence(type: EvidenceType): boolean {
  return EXECUTABLE_EVIDENCE_TYPES.has(type);
}

export function stripExecutableEvidence<T extends { type: EvidenceType; payload: string }>(
  evidence: T[] | undefined
): { safe: T[]; stripped: number } {
  const list = evidence ?? [];
  const safe = list.filter((e) => !isExecutableEvidence(e.type));
  return { safe, stripped: list.length - safe.length };
}
