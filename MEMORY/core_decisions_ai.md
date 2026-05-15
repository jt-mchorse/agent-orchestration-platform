# Core Decisions (AI-readable, YAML, append-only)
# Schema: see .skills/portfolio-memory/SKILL.md

- id: D-001
  date: 2026-05-10
  decision: scope_per_portfolio_handoff_section_2
  rationale: locked_scope_prevents_drift
  alternatives_rejected: []
  reversibility: expensive
  related_issues: []
  superseded_by: null

- id: D-002
  date: 2026-05-15
  decision: agent_use_case_is_pr_review_not_research_brief
  rationale: real_input_corpus_exists_in_jt_mchorse_org_outputs_scorable_vs_human_review_strong_hitl_motivation_dogfoods_into_portfolio
  alternatives_rejected: [research_brief_agent_softer_inputs_and_outputs]
  reversibility: expensive
  related_issues: [#1, #2, #3, #4, #6, #7]
  superseded_by: null
