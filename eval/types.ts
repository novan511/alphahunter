/** Shared types for the offline chatbot evaluation harness. */

export type ScenarioId =
  | 'market_query'
  | 'comparison'
  | 'risk_invalidation'
  | 'macro_regime'
  | 'ambiguous'
  | 'out_of_scope'
  | 'prompt_injection'
  | 'missing_data'
  | 'multi_turn'
  | 'adversarial_claim';

export interface Expectation {
  /** Does this prompt belong to the bot's domain? */
  scope: 'in' | 'out';
  /** Substrings that must appear in the answer (case-insensitive). */
  must_mention?: string[];
  /** Substrings that must NOT appear in the answer (case-insensitive). */
  must_not_mention?: string[];
  /** Financial disclaimer is required by the persona (default: true). */
  require_disclaimer?: boolean;
  /** Answer must explicitly say the data is unavailable / sample too small. */
  require_acknowledge_missing?: boolean;
  /** Answer must state trigger freshness (segar / telat). */
  require_timing?: boolean;
  max_paragraphs?: number;
  max_chars?: number;
}

export interface EvalCase {
  id: string;
  scenario: ScenarioId;
  prompt: string;
  /** Fixture name used as the grounded context for this case. */
  context_ref: string;
  expectation: Expectation;
  /** Recorded answer, or freshly generated when run with `--generate`. */
  actual: string;
  /** Optional prior turns, rendered into the production prompt's memory slot. */
  memory?: string;
}

export type MetricId =
  | 'scope'
  | 'grounding_numbers'
  | 'forbidden_claims'
  | 'format_plain_text'
  | 'disclaimer'
  | 'acknowledge_missing'
  | 'must_mention'
  | 'must_not_mention'
  | 'paragraph_limit'
  | 'char_limit'
  | 'timing'
  | 'llm_grounding'
  | 'llm_scope'
  | 'llm_helpfulness'
  | 'llm_tone';

export interface MetricResult {
  metric: MetricId;
  passed: boolean;
  /** Blocking failures fail the case regardless of the weighted score. */
  blocking: boolean;
  weight: number;
  detail: string;
}

export interface CaseResult {
  id: string;
  scenario: ScenarioId;
  prompt: string;
  score: number;
  passed: boolean;
  chars: number;
  paragraphs: number;
  metrics: MetricResult[];
}

export interface ScenarioSummary {
  scenario: ScenarioId;
  total: number;
  passed: number;
  passRate: number;
}

export interface EvalReport {
  generatedAt: string;
  source: 'recorded' | 'generated';
  model: string;
  threshold: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  weightedScore: number;
  llmJudge: boolean;
  byScenario: ScenarioSummary[];
  cases: CaseResult[];
  suitePassed: boolean;
}

/** Parsed response from the optional LLM-as-judge pass. */
export interface LLMJudgeScores {
  grounding: number;
  scope: number;
  helpfulness: number;
  tone: number;
  rationale: string;
}
