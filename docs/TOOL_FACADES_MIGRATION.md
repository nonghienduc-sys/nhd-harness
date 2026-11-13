# Tool facades: old name migration (v0.24.15+)

Since v0.24.15 related tools are merged into facades selected with an `op` argument. Old names are hidden from `tools/list` but remain callable as deprecated aliases (set `NHD_TOOL_FACADES=0` to restore the old flat list).

**Removal schedule:** aliases are removed no earlier than v0.24.18 and only after explicit owner approval. Update prompts, skills and scripts to the facade form before then.

Generated from `src/tool-facades.ts` (76 aliases).

| Old name | Facade | Op |
|---|---|---|
| `workstation_health_fast` | `workstation_health` | `op=fast` |
| `local_ai_status` | `local_ai_router` | `op=status` |
| `local_ai_route` | `local_ai_router` | `op=route` |
| `local_ai_dispatch` | `local_ai_router` | `op=dispatch` |
| `local_ai_verify` | `local_ai_router` | `op=verify` |
| `skills_list` | `skills_registry` | `op=list` |
| `skills_search` | `skills_registry` | `op=search` |
| `skills_get` | `skills_registry` | `op=get` |
| `skills_activate` | `skills_registry` | `op=activate` |
| `skills_read_resource` | `skills_registry` | `op=read_resource` |
| `skills_validate` | `skills_registry` | `op=validate` |
| `self_evolution_status` | `self_evolution_inspect` | `op=status` |
| `self_evolution_analyze` | `self_evolution_inspect` | `op=analyze` |
| `self_evolution_evaluate` | `self_evolution_inspect` | `op=evaluate` |
| `self_evolution_record_feedback` | `self_evolution_feedback` | `op=record_feedback` |
| `self_evolution_propose` | `self_evolution_feedback` | `op=propose` |
| `background_turbo_status` | `background_turbo` | `op=status` |
| `background_micro_batch` | `background_turbo` | `op=micro_batch` |
| `background_dag` | `background_turbo` | `op=dag` |
| `background_artifact_handle` | `background_turbo` | `op=artifact_handle` |
| `execution_lanes_status` | `execution_info` | `op=lanes_status` |
| `execution_route` | `execution_info` | `op=route` |
| `execution_scheduler` | `execution_control` | `op=scheduler` |
| `execution_lock` | `execution_control` | `op=lock` |
| `execution_handoff` | `execution_control` | `op=handoff` |
| `isolated_agent_start` | `isolated_agent_control` | `op=start` |
| `isolated_agent_stop` | `isolated_agent_control` | `op=stop` |
| `isolated_agent_status` | `isolated_desktop_read` | `op=agent_status` |
| `isolated_desktop_windows` | `isolated_desktop_read` | `op=windows` |
| `isolated_desktop_inspect` | `isolated_desktop_read` | `op=inspect` |
| `isolated_desktop_screenshot` | `isolated_desktop_read` | `op=screenshot` |
| `isolated_browser_status` | `isolated_browser_read` | `op=status` |
| `isolated_browser_snapshot` | `isolated_browser_read` | `op=snapshot` |
| `isolated_browser_inspect` | `isolated_browser_read` | `op=inspect` |
| `isolated_browser_screenshot` | `isolated_browser_read` | `op=screenshot` |
| `isolated_browser_navigate` | `isolated_browser_act` | `op=navigate` |
| `isolated_browser_click` | `isolated_browser_act` | `op=click` |
| `isolated_browser_fill` | `isolated_browser_act` | `op=fill` |
| `isolated_browser_press` | `isolated_browser_act` | `op=press` |
| `project_rag_status` | `project_rag_query` | `op=status` |
| `task_agent_cycle` | `task_protocol_status` | `op=agent_cycle` |
| `context_find_project` | `context_recall` | `op=find_project` |
| `context_chat_history` | `context_recall` | `op=chat_history` |
| `context_chat_binding` | `context_checkpoint` | `op=chat_binding` |
| `context_working_state` | `context_checkpoint` | `op=working_state` |
| `context_daily_progress` | `context_checkpoint` | `op=daily_progress` |
| `screen_list` | `screen_capture` | `op=list` |
| `screen_preview_capture` | `screen_capture` | `op=preview` |
| `screen_apply_capture` | `screen_capture` | `op=apply` |
| `desktop_windows` | `desktop_inspect` | `op=windows` |
| `video_inspect` | `video_understand` | `op=inspect` |
| `video_frame` | `video_understand` | `op=frame` |
| `video_context` | `video_understand` | `op=context` |
| `media_material_plan` | `media_source_discover` | `op=plan` |
| `media_material_rights_review` | `media_source_status` | `op=rights_review` |
| `project_status` | `project_open` | `op=status` |
| `project_memory` | `project_open` | `op=memory` |
| `project_decision` | `project_open` | `op=decision` |
| `project_sources` | `project_open` | `op=sources` |
| `project_snapshot` | `project_open` | `op=snapshot` |
| `document_index` | `document_context` | `op=index` |
| `document_related` | `document_context` | `op=related` |
| `document_edit_session` | `document_context` | `op=edit_session` |
| `document_qa` | `document_context` | `op=qa` |
| `outlook_read` | `outlook_search` | `op=read` |
| `office_admin_release_preview` | `office_admin_release_status` | `op=preview` |
| `office_live_append` | `office_live_insert_at_cursor` | `op=append` |
| `browser_wait` | `browser_inspect` | `op=wait` |
| `browser_wait_for` | `browser_inspect` | `op=wait_for` |
| `browser_screenshot` | `browser_inspect` | `op=screenshot` |
| `coc_coc_tabs` | `coc_coc_inspect` | `op=tabs` |
| `coc_coc_page` | `coc_coc_inspect` | `op=page` |
| `coc_coc_snapshot` | `coc_coc_inspect` | `op=snapshot` |
| `coc_coc_observe` | `coc_coc_inspect` | `op=observe` |
| `coc_coc_wait_for` | `coc_coc_inspect` | `op=wait_for` |
| `coc_coc_screenshot` | `coc_coc_inspect` | `op=screenshot` |
