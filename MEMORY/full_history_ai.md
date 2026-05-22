# Session History (AI-readable, append-only)

Schema: see .skills/portfolio-memory/SKILL.md

---
session: 2026-05-15T09:45Z
duration_min: 35
issue: 1
focus: lock_use_case_pr_review_agent
delta:
  files_added: 5
  files_changed: 3
  fixtures_committed: 2
context_for_next_session:
  - use_case_locked_pr_review_agent_d_002
  - sample_pr_fixtures_committed_v1_schema_in_fixtures_sample_prs_schema_md
  - five_tool_contracts_listed_in_docs_use_case_md_for_issue_2
  - ts_scaffold_deferred_to_issue_2_not_premature
decisions_made: [D-002]
followups: []
---

---
session: 2026-05-15T19:08Z
duration_min: 65
issue: 2
focus: tool_registry_and_four_replay_mode_tools
delta:
  files_added: 13
  files_changed: 3
  tests_added: 17
context_for_next_session:
  - tool_registry_lives_at_src_tools_registry_ts_with_zod_in_out_validation
  - four_tools_implemented_fetch_pr_read_file_at_ref_search_repo_run_check_all_replay_mode
  - mcp_server_portfolio_context_remains_open_on_issue_2_lands_with_mcp_server_cookbook_too
  - read_file_at_ref_supports_fixtures_file_cache_dir_or_reconstructs_added_status_files_from_patches
  - run_check_supports_fixtures_checks_dir_with_owner_repo_ref_slug
  - ci_yml_now_runs_typecheck_plus_npm_test_on_node_20_was_stub
  - planner_3_now_unblocked_on_tool_surface_only_pending_piece_is_mcp_server
decisions_made: []
followups: []
---

---
session: 2026-05-15T23:15Z
duration_min: 55
issue: 2
focus: portfolio_context_mcp_server_and_fifth_tool
delta:
  files_added: 8
  files_changed: 6
  tests_added: 17
  total_tests: 34
context_for_next_session:
  - mcp_server_portfolio_context_lives_at_mcp_server_portfolio_context_split_into_decisions_ts_server_ts_bin_ts
  - fifth_tool_get_portfolio_context_in_src_tools_dispatches_via_in_memory_transport_to_in_process_server
  - bin_runnable_for_real_stdio_use_via_dist_mcp_server_portfolio_context_bin_js_exposed_as_portfolio_context_mcp
  - tool_factory_pattern_create_get_portfolio_context_tool_accepts_injected_connect_fn_default_uses_in_process_in_memory_pair
  - repo_slug_validated_against_a_z_0_9_underscore_dot_dash_before_join_to_portfolio_root_no_path_escape
  - zod_minimum_bumped_to_3_25_to_satisfy_mcp_sdk_peer_dep
  - issue_2_now_fully_complete_pr_9_ready_for_merge
  - mirror_to_mcp_server_cookbook_explicitly_scoped_out_cookbook_is_for_generic_patterns_portfolio_context_is_portfolio_specific
  - planner_3_now_unblocked_on_full_tool_surface
decisions_made: []
followups: []
---

---
session: 2026-05-15T23:25Z
duration_min: 35
issue: 4
focus: hitl_destructive_tool_approval_flow_and_post_review_comment_shim
delta:
  files_added: 3
  files_changed: 5
  tests_added: 10
  total_tests: 44
context_for_next_session:
  - tool_interface_now_carries_optional_annotations_destructive_and_destructive_reason
  - registry_refuses_to_register_destructive_tool_without_destructive_reason_at_register_time
  - tool_context_now_carries_optional_approvals_provider_with_request_approval_method
  - registry_invoke_intercepts_destructive_tools_throws_tool_error_kind_approval_missing_or_approval_denied
  - cli_approval_provider_in_src_agent_cli_approval_ts_prompts_on_stderr_reads_y_n_on_stdin
  - auto_approve_provider_and_deny_all_provider_convenience_singletons_in_same_module
  - post_review_comment_tool_is_first_destructive_consumer_replay_mode_renders_preview_string_live_mode_stubbed
  - new_tool_count_six_not_five_post_review_comment_is_a_post_planner_addition_visible_destructive_surface
  - registry_list_now_returns_destructive_flag_per_tool_existing_test_updated
  - issue_4_acceptance_destructive_flag_done_cli_half_of_pause_resume_done_ui_half_deferred_to_issue_6_test_destructive_never_fires_without_approval_covered
  - selection_rule_deviation_picked_issue_4_60min_over_issue_3_90min_for_time_budget_safety_documented_in_plan_comment
decisions_made: []
followups: []
---

---
session: 2026-05-16T03:22Z
duration_min: 50
issue: 3
focus: agent_loop_planner_executor_replanner
delta:
  files_added: 5
  files_changed: 2
  tests_added: 13
  total_tests: 57
context_for_next_session:
  - agent_loop_lives_in_src_agent_split_into_types_planner_trace_executor_ts
  - planner_interface_has_three_methods_initialplan_revise_finalize_d_003
  - scriptedplanner_is_the_test_utility_takes_canned_initial_plus_revision_callbacks
  - anthropicplanner_deliberately_deferred_until_issue_6_traces_and_issue_7_evals_exist_no_dead_seam
  - agentrun_walks_plan_steps_on_toolerror_calls_planner_revise_resumes_from_new_plan_step_0
  - replan_budget_default_5_configurable_via_executoroptions_d_004_aborts_emit_aborted_event_then_finalize_still_runs
  - replanreason_distinguishes_tool_error_from_approval_denied_so_planner_can_branch_on_intent
  - non_toolerror_throws_are_re_raised_not_converted_to_replan_to_avoid_swallowing_programmer_bugs
  - trace_uses_distributed_omit_type_to_keep_discriminated_union_sound_under_pluggable_clock
  - integration_test_wires_builddefaultregistry_against_committed_rag_production_kit_pr9_fixture_no_real_network
  - issue_3_acceptance_planner_executor_replanner_loop_done_decisions_visible_in_trace_unit_tests_with_mock_tools_done
decisions_made: [D-003, D-004]
followups: []
---

---
session: 2026-05-16T03:33Z
duration_min: 65
issue: 6
focus: trace_observability_pg_schema_plus_tracestore_plus_react_via_cdn_viewer
delta:
  files_added: 10
  files_changed: 5
  tests_added: 20
  total_tests: 77
context_for_next_session:
  - infra_postgres_init_sql_two_tables_runs_and_trace_events_jsonb_payload_indexed_on_run_id_seq
  - docker_compose_yml_at_repo_root_runs_pg_on_host_port_5433_to_avoid_collision_with_rag_kit_5432
  - tracestore_interface_in_src_trace_store_ts_with_memorystore_and_pgstore_implementations
  - pgstore_lazy_imports_pg_package_listed_as_optional_dependency
  - observation_type_extended_with_optional_stepcost_input_tokens_output_tokens_dollars
  - aggregatecost_skips_missing_fields_per_d_005_not_treated_as_zero
  - ui_in_src_ui_server_ts_plus_index_html_plus_app_js_react_via_esm_cdn_d_006_no_bundler
  - trace_server_bin_script_npm_run_trace_server_memory_or_against_database_url
  - ci_pg_integration_job_added_brings_up_pg_service_container_applies_init_sql_runs_marked_tests
  - 13_hermetic_store_tests_9_server_endpoint_tests_4_pg_integration_tests_skipped_unless_database_url_set
  - acceptance_pg_schema_committed_done_ui_lists_runs_opens_run_with_timeline_done_costs_aggregated_per_run_done
decisions_made: [D-005, D-006]
followups: []
---

---
session: 2026-05-17T19:15Z
duration_min: 50
issue: 5
focus: per_tool_retry_and_one_hop_fallback_with_trace_events
delta:
  files_added: 2  # src/agent/retry.ts, test/agent/retry.test.ts
  files_changed: 5  # tools/types.ts, agent/trace.ts, agent/executor.ts, test/agent/executor.test.ts, README.md, docs/architecture.md
  tests_added: 15  # 9 retry unit + 6 executor retry/fallback
  total_tests: 125
context_for_next_session:
  - retry_policy_lives_on_tool_annotations_retry_with_maxattempts_backoffms_backoff_multiplier_retryable_kinds_d_012
  - fallback_to_string_on_tool_annotations_one_hop_only_fallbacks_own_fallback_to_not_followed_so_no_cycles
  - default_retryable_kinds_is_just_internal_validation_kinds_never_retried_by_default
  - retry_helper_in_src_agent_retry_ts_pure_no_knowledge_of_trace_registry_planner_sleep_pluggable_for_tests
  - executor_run_step_with_retry_and_fallback_wraps_primary_then_fallback_then_replan_in_that_order
  - replan_reason_tool_name_now_uses_error_tool_name_not_step_tool_so_fallback_failures_report_the_fallback_name
  - fallback_to_pointing_at_unregistered_tool_surfaces_as_internal_toolerror_observation_not_a_crash
  - trace_event_retry_attempted_tool_name_attempt_backoff_ms_error_one_per_failed_attempt_that_will_be_retried
  - trace_event_fallback_used_from_to_error_one_when_retries_exhaust_and_fallback_declared
  - planner_sees_exactly_one_observation_per_step_regardless_of_retry_or_fallback_count
  - issue_5_acceptance_per_tool_retry_policy_done_fallback_chains_testable_done_trace_shows_every_retry_done
decisions_made: [D-012]
followups: []
---


---
session: 2026-05-16T04:45Z
duration_min: 50
issue: 7
focus: agent_eval_suite_score_runner_comment_workflow
delta:
  files_added: 9
  files_changed: 4
  tests_added: 33
  total_tests: 110
context_for_next_session:
  - eval_suite_lives_in_src_eval_split_into_score_runner_comment_ts
  - scorereview_returns_recommendation_match_findings_f1_summary_length_ratio_composite_weighted_avg
  - matchfindings_greedy_1_to_1_severity_keyed_jaccard_threshold_0_3_d_011
  - sticky_comment_marker_is_agent_eval_sticky_comment_distinct_from_eval_harness_marker_d_010
  - upsertstickycomment_uses_global_fetch_test_doubles_via_fetchimpl_override_no_msw_dep
  - runner_uses_scriptedplanner_with_heuristic_review_for_fixture_anthropic_planner_swaps_in_later
  - golden_fixtures_are_two_hand_labeled_jsons_one_per_committed_pr_fixture
  - eval_yml_workflow_runs_on_pull_request_against_main_pull_requests_write_permission_uses_secrets_github_token
  - npm_run_eval_bin_supports_dry_run_and_comment_writes_results_json_per_run
  - smoke_tested_locally_baseline_composite_0_345_50pct_recommendation_accuracy_with_scripted_agent
  - issue_7_acceptance_eval_yml_wired_done_golden_traces_in_fixtures_done_pr_comment_with_deltas_done
decisions_made: [D-010, D-011]
followups: []
---

---
session: 2026-05-18T23:18Z
duration_min: 30
issue: 15
focus: readme_truth_pass_real_eval_numbers_published_plus_snapshot_test
delta:
  files_changed: 1   # README.md
  files_added: 3     # docs/eval_snapshot.md, scripts/render-eval-snapshot.ts, test/readme-snapshot.test.ts
  tests_added: 11
  test_pass_rate: "136/136 + 4 skipped"
  typecheck_pass: true
  build_pass: true
context_for_next_session:
  - readme_quickstart_now_covers_all_three_runnable_surfaces_registry_eval_dry_run_trace_server_dropped_hardcoded_test_count
  - benchmarks_results_publishes_real_numbers_from_scripted_planner_composite_0_345_rec_acc_50pct_f1_0_000_honest_low_disclosure_for_baseline_planner_state
  - docs_eval_snapshot_md_committed_as_source_of_truth_byte_locked_to_render_eval_markdown_evaluate_all_discover_cases
  - new_script_render_eval_snapshot_ts_writes_the_file_no_timestamp_no_npm_header
  - new_test_readme_snapshot_test_ts_eleven_tests_three_layers_snapshot_byte_lock_readme_table_numerics_lock_npm_scripts_locked_to_package_json
  - failure_path_verified_tamper_composite_0_345_to_0_999_test_fired_then_regen_restored
  - demo_capture_60s_filed_as_followup_16_low_priority_no_capture_today
  - pattern_parallels_today_snapshot_tests_in_cost_optimizer_prompt_regression_rag_kit_nextjs_streaming
decisions_made: []
followups: [#16]
---

---
session: 2026-05-20T03:42Z
duration_min: 30
issue: 18
focus: ts_public_surface_pattern_first_typescript_translation_locks_src_index_ts
delta:
  files_added: 1   # test/public-surface.test.ts (vitest)
  files_changed: 0
  tests_added: 6   # 4 standalone, 1 of which is it.each over 3 README names → 6 test items total
  test_pass_rate: "142/142 + 4 skipped"
  typecheck_pass: true
context_for_next_session:
  - first_typescript_variant_of_portfolio_wide_public_surface_pattern_uses_vitest_imports_star_as_index_object_keys_for_all_analog
  - four_axes_pkg_version_semver_value_exports_defined_readme_quoted_imports_resolve_bin_source_exists
  - bin_test_resolves_dist_path_back_to_source_via_tsconfig_rootdir_outdir_no_build_step_in_ci_test_job
  - type_only_exports_intentionally_out_of_scope_object_keys_doesnt_see_them
  - tamper_verified_three_axes_bad_version_rename_buildDefaultRegistry_bad_bin_target
  - portable_to_remaining_two_ts_repos_nextjs_streaming_ai_patterns_ai_app_integration_tests
  - readme_quotes_two_import_snippets_lines_73_and_119_123_union_three_names_buildDefaultRegistry_createCliApprovalProvider_autoApproveProvider
decisions_made: []
followups: []
---

---
session: 2026-05-21T19:40Z
duration_min: 25
issue: 16
focus: scripts_capture_demo_sh_two_surface_60s_driver_plus_vitest_smoke_test
delta:
  files_added: 2   # scripts/capture_demo.sh, test/capture-demo-smoke.test.ts
  files_changed: 1 # README.md (Demo section pending → real invocation)
  tests_added: 4
  test_pass_rate: "146 passed / 4 skipped / 1 file skipped"
context_for_next_session:
  - ninth_repo_to_land_capture_demo_sh_pattern_this_week_first_typescript_repo_in_the_run
  - two_surfaces_npm_run_eval_dry_run_then_npm_run_trace_server_memory_background_plus_curl_api_runs
  - browser_tour_deliberately_not_in_the_script_would_need_playwright_puppeteer_heavy_dep_curl_api_runs_locks_same_json_shape_react_ui_consumes
  - sticky_comment_marker_html_comment_agent_eval_sticky_comment_is_load_bearing_for_gh_actions_in_place_comment_edit_smoke_test_pins_it
  - memory_store_seeded_runs_sample_finalized_and_sample_aborted_test_pins_both_names
  - background_server_reaped_via_exit_int_term_trap_port_poll_loop_250ms_x_25_before_curl
  - capture_demo_port_overridable_via_capture_trace_port_env_default_8766
  - no_new_d_entry_pure_glue_leveraging_existing_dry_run_and_memory_paths
decisions_made: []
followups: []
---

---
session: 2026-05-22T03:40Z
duration_min: 30
issue: 21
focus: rename_tool_error_kind_unsupported_in_replay_to_unsupported_in_live_kind_was_thrown_in_live_mode_not_replay
delta:
  files_changed: 7   # types.ts, fetch-pr.ts, read-file-at-ref.ts, run-check.ts, search-repo.ts, post-review-comment.ts, retry.ts, agent/types.ts, docs/architecture.md
  files_added: 2     # test/tools/live-mode-error-kind.test.ts, test/tools/error-kind-source-snapshot.test.ts
  tests_added: 9
  test_pass_rate: "155/155 (passed) + 4 skipped"
  build_regenerated: true
decisions_made: []
context_for_next_session:
  - toolerrorkind_literal_unsupported_in_replay_was_thrown_in_5_places_all_when_ctx_mode_was_live_not_replay_name_lied_about_trigger
  - retry_helper_docstring_called_it_a_fixture_gap_but_fixture_gaps_are_actually_not_found
  - rename_to_unsupported_in_live_propagates_to_types_ts_5_throw_sites_retry_ts_docstring_agent_types_ts_docstring_docs_architecture_md_dist_regenerated
  - runtime_lock_in_test_tools_live_mode_error_kind_test_ts_one_test_per_tool_with_live_mode_stub_post_review_comment_needs_auto_approve_provider_to_clear_the_destructive_gate_before_the_kind_fires
  - source_snapshot_lock_in_test_tools_error_kind_source_snapshot_test_ts_four_tests_types_ts_includes_unsupported_in_live_and_excludes_unsupported_in_replay_retry_ts_and_architecture_md_likewise
  - retry_semantics_unchanged_kind_was_non_retryable_default_now_still_non_retryable_just_with_truthful_name
  - fifth_post_v0_1_drift_fix_today_after_emb_shootout_chunking_lab_vector_search_at_scale_python_async_llm_pipelines
followups: []
---
