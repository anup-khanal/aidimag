package com.aidimag.intellij.toolwindow

data class MemoryNode(
  val id: String,
  val shortId: String,
  val kind: String,
  val status: String,      // VERIFIED | STALE | UNVERIFIED | REFUTED
  val confidence: Double,
  val claim: String,
  val pinned: Boolean,
  val paths: List<String>,
  val symbols: List<String>,
  val evidence: List<EvidenceNode>,
  val ticketRef: String?,
  val createdAt: String?,
  val guardrailLevel: String? = null,   // never | ask-first | always (GUARDRAIL only)
) {
  val statusIcon: String get() = when (status) {
    "VERIFIED"   -> "✓"
    "STALE"      -> "~"
    "REFUTED"    -> "✗"
    else         -> "?"
  }
  val shortClaim: String get() = if (claim.length > 90) claim.take(90) + "…" else claim
}

data class EvidenceNode(
  val type: String,    // STATIC_CHECK | COMMIT_REF | TEST_RESULT | EXEC_TRACE | HUMAN_ATTESTED | TICKET_REF
  val result: String,  // PASS | FAIL | UNKNOWN
  val payload: String,
) {
  val resultIcon: String get() = when (result) { "PASS" -> "✓"; "FAIL" -> "✗"; else -> "·" }
}

