---
name: epidemiological-debug
description: "Population-level debugging using epidemiological analysis to identify distinct bug clusters and validate hypotheses quantitatively"
argument-hint: "[list | status <slug> | continue <slug>] [problem description]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

# Epidemiological Debug

Debug issues using population-level analysis instead of individual case inspection.

> *"The most important step was not the clever assembly reading or deep knowledge of the details.
> It was building a high-quality data set."*
> — OpenAI, "Core dump epidemiology: fixing an 18-year-old bug"

<objective>
Investigate problems by analyzing the ENTIRE population of events, identifying distinct clusters,
and validating hypotheses quantitatively using Fermi estimation.

**Philosophy:**
- Population over individual: Analyze ALL events, not samples
- Data quality is everything: Automated pipeline for normalization and classification
- Correlation reveals clusters: Patterns emerge from population data that single cases cannot reveal
- Multiple bugs masquerade as one: Always consider that "1 bug" might be N distinct bugs
- Fermi validation required: Hypotheses must be validated quantitatively
- Evidence over speculation: If evidence is insufficient, admit it — don't fabricate causes

**Subcommands:** `list` · `status <slug>` · `continue <slug>`
</objective>

<available_agent_types>
Valid subagent types (use exact names):
- epi-collector — collects ALL events from data sources (population-level)
- epi-classifier — classifies events with deterministic rules + LLM assistance
- epi-cluster-analyzer — identifies distinct populations via correlation analysis
- epi-hypothesis-generator — generates hypotheses based on cluster correlations
- epi-fermi-validator — validates hypotheses quantitatively using Fermi estimation
</available_agent_types>

<context>
User's input: $ARGUMENTS

Parse subcommands from $ARGUMENTS:
- If $ARGUMENTS starts with "list": SUBCMD=list
- If $ARGUMENTS starts with "status ": SUBCMD=status, SLUG=remainder
- If $ARGUMENTS starts with "continue ": SUBCMD=continue, SLUG=remainder
- If $ARGUMENTS contains "--cluster-only": SUBCMD=cluster-only, SLUG from args
- If $ARGUMENTS contains "--fermi-only": SUBCMD=fermi-only, SLUG from args
- Otherwise: SUBCMD=new, DESCRIPTION=$ARGUMENTS

Skill directory (for scripts): This skill's files are located at `~/.claude/skills/epidemiological-debug/`
</context>

<process>

## Phase 0 — Subcommand Routing

### 0a. LIST subcommand

When SUBCMD=list:

```bash
ls .planning/epidemiological/*/STATE.md 2>/dev/null | head -20
```

For each investigation found, parse and display:
```
Active Epidemiological Investigations
───────────────────────────────────────────────────
  #  Slug                    Phase          Events    Clusters
  1  api-crashes             cluster        1,247     3
  2  auth-timeouts           fermi          892       2
───────────────────────────────────────────────────
Run `/epidemiological-debug continue <slug>` to resume.
```

STOP after displaying list.

### 0b. STATUS subcommand

When SUBCMD=status and SLUG is set:

Read `.planning/epidemiological/{SLUG}/STATE.md` and display:
- Current phase
- Events collected/classified
- Clusters identified
- Hypotheses generated
- Fermi validation status

STOP after displaying status.

### 0c. CONTINUE subcommand

When SUBCMD=continue and SLUG is set:

Read `.planning/epidemiological/{SLUG}/STATE.md` to determine current phase.
Resume from that phase (skip completed phases).

### 0d. NEW investigation

When SUBCMD=new:

Continue to Phase 1 (Intake).

---

## Phase 1 — INTAKE

**Goal:** Identify the problem and locate data sources.

Use AskUserQuestion to gather:

1. **Problem Type:**
   - Crashes/Segfaults/Core dumps
   - Application errors (logs)
   - Performance degradation
   - Flaky/intermittent test failures
   - Other (describe)

2. **Data Sources:** (can select multiple)
   - Log files (path: ___)
   - Core dumps directory (path: ___)
   - Metrics endpoint (URL: ___)
   - Database/query (connection: ___)
   - Git history for correlation
   - Other (describe)

3. **Time Range:**
   - Start date (or "all available")
   - End date (or "now")

4. **Available Metadata:** (checkboxes)
   - Hostname/Host ID
   - Region/Datacenter
   - Software version
   - Hardware SKU
   - Precise timestamps

Generate slug from description:
- Lowercase, replace spaces with hyphens
- Max 30 chars, alphanumeric + hyphens only
- Example: "API crashes on payment service" → "api-crashes-payment"

Create investigation directory:
```bash
mkdir -p .planning/epidemiological/{slug}
```

Write initial STATE.md:
```markdown
---
slug: {slug}
description: {description}
problem_type: {type}
created: {ISO timestamp}
phase: intake
---

## Data Sources
{list of sources with paths}

## Time Range
- Start: {start}
- End: {end}

## Available Metadata
{list of available fields}

## Progress
- [ ] Phase 2: Ingest (collect all events)
- [ ] Phase 3: Extract Features
- [ ] Phase 4: Classify
- [ ] Phase 5: Cluster Analysis
- [ ] Phase 6: Hypothesis Formation
- [ ] Phase 7: Fermi Validation
- [ ] Phase 8: Report
```

[User confirmation]: "Data sources configured. Ready to collect events?"

---

## Phase 2 — INGEST (Population Collection)

**Goal:** Collect ALL events, not samples.

**Critical principle:** The power of epidemiological analysis comes from having the COMPLETE population.

Dispatch epi-collector agent:

```
Agent(
  prompt="""
Collect ALL events from the configured data sources.

Investigation: {slug}
Data sources: {sources from STATE.md}
Time range: {start} to {end}
Output: .planning/epidemiological/{slug}/events.json

CRITICAL: Collect EVERY event, not samples. The epidemiological method requires
the complete population to identify patterns that individual cases cannot reveal.

For each event, extract:
- id: unique hash of the event
- timestamp: precise time (ISO 8601)
- source: which data source
- raw: original event data
- metadata: {host, region, version, hardware_sku} where available

Report collection statistics:
- Total events collected
- Events per source
- Time range coverage
- Metadata completeness
""",
  subagent_type="epi-collector",
  description="Collect population of events"
)
```

**Gate checks:**
- If N < 10: Warn "Sample too small for epidemiological analysis. Consider traditional debugging."
- If N > 10000: Inform "Large dataset ({N} events). Processing may take several minutes."

Update STATE.md with collection stats.

---

## Phase 3 — EXTRACT FEATURES

**Goal:** Extract features relevant for classification.

Run the feature extraction script:

```bash
node ~/.claude/skills/epidemiological-debug/scripts/extract-features.mjs \
  .planning/epidemiological/{slug}
```

The script:
1. Reads events.json
2. Detects event type (crash, log, metric, test)
3. Calls appropriate extractor (crash-extractor.mjs, log-extractor.mjs, etc.)
4. Writes features.json

Features extracted per type:
| Type | Features |
|------|----------|
| Crash | signal, fault_address, stack_fingerprint, register_state |
| Log | error_code, message_hash, component, severity, pattern |
| Metric | latency_p50/p95/p99, throughput, error_rate |
| Test | test_name, failure_hash, assertion_type, flakiness_score |

Update STATE.md with feature extraction stats.

---

## Phase 4 — CLASSIFY

**Goal:** Assign classification labels to each event.

Dispatch epi-classifier agent:

```
Agent(
  prompt="""
Classify events using a two-layer approach:

Investigation: {slug}
Input: .planning/epidemiological/{slug}/features.json
Output: .planning/epidemiological/{slug}/classified.json

Layer 1 - Deterministic Rules (fast, precise):
- Pattern matching on stack traces
- Regex on error messages
- Threshold checks on metrics

Layer 2 - Semantic (LLM-assisted):
- Group similar messages that don't match rules
- Identify non-obvious patterns
- Suggest new classification labels

Each event gets a `classification_label` field.

Common labels:
- return-to-null, misaligned-stack, null-pointer-deref (crashes)
- timeout, connection-refused, auth-failed (network)
- oom, resource-exhausted, rate-limited (resources)
- assertion-failed, flaky-timing, env-dependent (tests)
""",
  subagent_type="epi-classifier",
  description="Classify events"
)
```

Update STATE.md with classification distribution.

---

## Phase 5 — CLUSTER ANALYSIS

**Goal:** Identify distinct populations. This is where we discover if "1 bug" is actually "N bugs".

Dispatch epi-cluster-analyzer agent:

```
Agent(
  prompt="""
Identify distinct event populations through correlation analysis.

Investigation: {slug}
Input: .planning/epidemiological/{slug}/classified.json
Output: .planning/epidemiological/{slug}/clusters.json

Perform multi-dimensional correlation:

1. TEMPORAL ANALYSIS:
   - Event distribution over time (histogram by hour/day)
   - Distinct start dates (when did each cluster begin?)
   - Anomalous spikes

2. INFRASTRUCTURE CORRELATION:
   - Group by host/hostname
   - Group by region/datacenter
   - Group by software version
   - Group by hardware SKU

3. CLASSIFICATION CORRELATION:
   - Group by classification_label
   - Cross-correlate labels with infrastructure

4. IDENTIFY DISTINCT CLUSTERS:
   - Minimum cluster size: 5 events
   - Minimum correlation strength: 0.7
   - Each cluster should have distinctive characteristics

Key questions to answer:
- Do events have DISTINCT START DATES?
- Are they CONCENTRATED on specific hosts?
- Is there CORRELATION with deploy versions?
- Is the distribution UNIFORM or are there SPIKES?
- HOW MANY DISTINCT BUGS are we seeing?

For each cluster, output:
{
  "cluster_id": "cluster-1",
  "name": "descriptive name",
  "event_count": N,
  "percentage": X%,
  "distinctive_features": [...],
  "temporal_pattern": {...},
  "infrastructure_correlation": {...}
}
""",
  subagent_type="epi-cluster-analyzer",
  description="Identify distinct populations"
)
```

[User confirmation]: "Identified {N} distinct clusters. Review boundaries before continuing."

Present cluster summary for user review.

Update STATE.md with cluster information.

---

## Phase 6 — HYPOTHESIS FORMATION

**Goal:** Generate hypotheses based on cluster correlations, not speculation.

Dispatch epi-hypothesis-generator agent:

```
Agent(
  prompt="""
Generate hypotheses for each cluster based on observed correlations.

Investigation: {slug}
Input: .planning/epidemiological/{slug}/clusters.json
Output: .planning/epidemiological/{slug}/hypotheses.json

For each cluster, generate hypotheses based ONLY on evidence:

1. ANALYZE CORRELATIONS:
   - If concentrated on 1 host → hardware failure likely
   - If started on specific date → correlate with deploys/changes
   - If correlates with region → infrastructure/network issue
   - If uniform but recent → software bug introduced

2. RANK BY EVIDENCE STRENGTH:
   - Correlation coefficient
   - Temporal consistency
   - Coverage (% of events explained)

3. OUTPUT FORMAT per cluster:
{
  "cluster_id": "cluster-1",
  "observations": [...],
  "hypotheses": [
    {
      "hypothesis": "Hardware failure on host-az1-042",
      "confidence": "HIGH",
      "evidence": [...],
      "counter_evidence": [...],
      "fermi_parameters": {
        "description": "Parameters needed for quantitative validation",
        "values": {...}
      }
    }
  ],
  "primary_hypothesis": "..."
}

CRITICAL: Ground every hypothesis in observed data. 
If evidence is insufficient, say "insufficient data" — do NOT speculate.
""",
  subagent_type="epi-hypothesis-generator",
  description="Generate hypotheses"
)
```

Update STATE.md with hypotheses.

---

## Phase 7 — FERMI VALIDATION

**Goal:** Validate hypotheses quantitatively. This is the step most debugging skips.

Dispatch epi-fermi-validator agent:

```
Agent(
  prompt="""
Validate each primary hypothesis using Fermi estimation.

Investigation: {slug}
Input: .planning/epidemiological/{slug}/hypotheses.json
Output: .planning/epidemiological/{slug}/fermi-validation.json

For each hypothesis:

1. IDENTIFY PARAMETERS:
   - What physical/logical quantities determine the event rate?
   - Example: race condition window, signal frequency, exception rate

2. ESTIMATE VALUES:
   - Use order-of-magnitude estimates
   - Document assumptions and sources

3. CALCULATE EXPECTED RATE:
   - Combine parameters to predict event frequency
   - Example: P(race) = window / signal_interval

4. COMPARE TO OBSERVED:
   - Calculate |log₁₀(expected/observed)|
   - If < 1: PLAUSIBLE (within order of magnitude)
   - If >= 1: IMPLAUSIBLE (hypothesis likely wrong)

EXAMPLE (from OpenAI article):
```
Hypothesis: Race condition in libunwind (1-instruction window)

Parameters:
- Vulnerable window: ~10⁻¹⁰ seconds
- Signal frequency: ~10⁻² seconds
- P(race per exception): ~10⁻⁸
- Exceptions/second under load: ~10⁴

Expected MTBF per host: 10⁴ seconds (~3 hours)
Expected crashes/day (fleet): ~400

Observed crashes/day: ~350-450

|log₁₀(400/400)| = 0 < 1

VERDICT: PLAUSIBLE
```

Output format:
{
  "cluster_id": "cluster-1",
  "hypothesis": "...",
  "parameters": {...},
  "expected_rate": {...},
  "observed_rate": {...},
  "log_ratio": X,
  "verdict": "PLAUSIBLE" | "IMPLAUSIBLE",
  "confidence_notes": "..."
}
""",
  subagent_type="epi-fermi-validator",
  description="Validate with Fermi estimation"
)
```

[User confirmation]: "Review Fermi calculations before finalizing report."

Present validation results for user review.

Update STATE.md with Fermi results.

---

## Phase 8 — REPORT

**Goal:** Generate comprehensive epidemiological report.

Run report generation script:

```bash
node ~/.claude/skills/epidemiological-debug/scripts/generate-report.mjs \
  .planning/epidemiological/{slug}
```

The report includes:
1. Executive Summary
2. Population Analysis (clusters)
3. Hypothesis per cluster with Fermi validation
4. Recommended Actions (prioritized)
5. Data Quality assessment
6. Methodology notes
7. Appendix with raw data paths

Write to: `.planning/epidemiological/{slug}/EPIDEMIOLOGICAL-REPORT.md`

Update STATE.md:
```markdown
phase: complete
completed: {ISO timestamp}
```

Present report summary to user.

</process>

<success_criteria>
- [ ] Population-level data collection (ALL events, not samples)
- [ ] Automatic classification with labels
- [ ] Identification of distinct clusters
- [ ] Multi-dimensional correlation (time, host, region, version)
- [ ] Hypotheses grounded in data, not speculation
- [ ] Fermi validation of each primary hypothesis
- [ ] Structured report with evidence
- [ ] Prioritized recommended actions
</success_criteria>

<critical_rules>
- **Collect the entire population:** The method's power comes from complete data
- **Never speculate without evidence:** If data is insufficient, admit it
- **Always consider multiple bugs:** What looks like one bug may be N distinct bugs
- **Fermi validation is mandatory:** Hypotheses must be quantitatively plausible
- **Preserve raw data:** Keep events.json, features.json, etc. for audit
- **Document methodology:** Every assumption must be recorded
</critical_rules>
