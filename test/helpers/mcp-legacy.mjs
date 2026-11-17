// Legacy registry fixtures deliberately test direct tool routing rather than Brain-only connection policy.
// Scope the override to child processes that import this test helper; production never imports it.
process.env.NHD_BRAIN_ONLY = "0";
import { createWorkstationMcp as createRuntimeMcp, getWorkstationToolInventory } from '../../dist/mcp.js';
import { createWorkstationRuntime } from '../../dist/workstation-runtime.js';

export { getWorkstationToolInventory };

export function createWorkstationMcp(
  config, store, files, terminal, office, skills, screen, projects, documents, desktop, intake, pdf, desktopIntake,
  browser, terminalSessions, taskRuns, workspaceMemory, video, cocCocBridge, localIntelligence, executionLanes,
  isolatedAgent, backgroundTurbo, healthSnapshot, planState, sharedGovernor,
) {
  return createRuntimeMcp(createWorkstationRuntime({
    config, store, files, terminal, office, skills, screen, projects, documents, desktop, intake, pdf, desktopIntake,
    browser, terminalSessions, taskRuns, workspaceMemory, video, cocCocBridge, localIntelligence, executionLanes,
    isolatedAgent, backgroundTurbo, healthSnapshot, planState, governor: sharedGovernor,
  }));
}
