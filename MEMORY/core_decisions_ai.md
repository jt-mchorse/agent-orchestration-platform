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

- id: D-003
  date: 2026-05-16
  decision: planner_is_a_three_method_typescript_interface_initialplan_revise_finalize
  rationale: matches_portfolio_protocol_pattern_tool_reranker_embedder_single_seam_per_phase_lets_scriptedplanner_drive_tests_without_an_llm
  alternatives_rejected: [single_method_step_protocol, react_style_function_per_decision, class_hierarchy_with_baseplanner]
  reversibility: cheap
  related_issues: [#3, #6, #7]
  superseded_by: null

- id: D-004
  date: 2026-05-16
  decision: replan_budget_defaults_to_5_configurable_per_run_bounded_by_max_replans
  rationale: prevents_runaway_loops_on_misbehaving_planners_loose_enough_for_normal_tool_error_revise_continue_paths_tight_enough_to_surface_bugs_in_seconds
  alternatives_rejected: [unbounded_loop_with_external_kill_switch, hardcoded_3_replans_too_tight, dollar_budget_instead_of_step_budget_not_known_until_llm_planner_lands]
  reversibility: cheap
  related_issues: [#3]
  superseded_by: null

- id: D-005
  date: 2026-05-16
  decision: tracestore_writes_at_finalize_time_aggregatecost_skips_missing_fields
  rationale: in_memory_trace_is_streaming_surface_pg_is_at_rest_surface_partial_costs_should_show_partial_totals_not_misleading_zero
  alternatives_rejected: [stream_per_event_inserts_extra_round_trips, treat_missing_cost_as_zero_misleading, fail_on_partial_cost_too_brittle]
  reversibility: cheap
  related_issues: [#6, #7]
  superseded_by: null

- id: D-006
  date: 2026-05-16
  decision: trace_viewer_is_react_via_esm_cdn_plus_htm_no_bundler
  rationale: minimal_react_ui_requirement_met_with_zero_npm_react_surface_consistent_with_rag_production_kit_d011_stdlib_http_server_pattern
  alternatives_rejected: [vite_or_webpack_bundler_chain_too_much_infra_for_a_debug_viewer, plain_html_no_react_violates_issue_acceptance, preact_swap_diverges_from_repo_stack]
  reversibility: cheap
  related_issues: [#6]
  superseded_by: null

- id: D-010
  date: 2026-05-16
  decision: agent_eval_suite_ships_in_typescript_does_not_pip_install_eval_harness
  rationale: review_shape_is_typescript_side_already_python_install_in_action_costs_minutes_per_pr_with_no_capability_unlock_sticky_marker_pattern_borrowed_idea_not_impl
  alternatives_rejected: [python_eval_harness_via_pip_install_in_workflow, cross_language_subprocess_call, run_eval_harness_as_separate_workflow_after_agent_writes_results]
  reversibility: cheap
  related_issues: [#7]
  superseded_by: null

- id: D-011
  date: 2026-05-16
  decision: findings_precision_recall_uses_greedy_1_to_1_matching_keyed_by_severity_jaccard_threshold_0_3
  rationale: prevents_double_counting_a_single_finding_against_multiple_goldens_severity_lock_avoids_blocker_matching_praise_jaccard_works_well_on_short_review_findings
  alternatives_rejected: [unrestricted_many_to_one_matching_double_counts, cosine_over_embeddings_dep_for_short_text_overkill, no_severity_check_lets_unrelated_findings_match]
  reversibility: cheap
  related_issues: [#7]
  superseded_by: null

- id: D-012
  date: 2026-05-17
  decision: retry_policy_and_fallback_to_live_on_tool_annotations_not_in_an_executor_side_policy_map
  rationale: tool_author_knows_their_tool_is_transiently_flaky_and_which_alternative_shares_io_contract_keeping_policy_with_the_tool_keeps_registry_list_self_describing_and_policy_cannot_silently_drift_from_tool_changes_data_with_the_tool_d_005_pattern_consistency
  alternatives_rejected: [executor_side_retry_policy_map_lets_policy_drift_from_tools, per_run_dynamic_override_only_overkill_for_acceptance_criteria, expose_callback_per_event_overkill_dataclass_surface_is_simpler]
  reversibility: cheap
  related_issues: [#5]
  superseded_by: null
