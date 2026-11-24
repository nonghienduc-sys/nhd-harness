import type { CapabilitySnapshot, CapabilityRisk } from "./capability-registry.js";
import { capabilityRisk, capabilityStaticMetadata } from "./capability-registry.js";
import type { ExecutionLane, ExecutionPreference, ExecutionRoutePlan, ExecutionRouteRequest, IsolatedLaneStatus } from "./execution-lanes.js";
import type { OfficeQaLevel } from "./office.js";
import { qaLevelForOperationType } from "./office.js";
import type { ConfirmationMode, DangerLevel, RiskAssessment } from "./risk-policy.js";
import { assessTerminalRisk, confirmationForLevel, dangerLevel } from "./risk-policy.js";
import type { RoutePlan, TaskIntent, WorkstationRouter } from "./router.js";
import type { ToolGovernorService } from "./tool-governor.js";
import { classifyIntentPolicy } from "./tool-governor.js";
import type { ArtifactPlan, ArtifactPlanInput } from "./artifact-intelligence.js";
import { planArtifactWorkflow } from "./artifact-intelligence.js";

export type PlannedOfficeOperationType =
  | "replace_selection"
  | "word_insert_at_cursor"
  | "word_append"
  | "word_format"
  | "word_format_paragraphs"
  | "word_replace_paragraph"
  | "word_page_setup"
  | "word_save"
  | "excel_set_range"
  | "excel_set_formula"
  | "excel_format_range"
  | "excel_save"
  | "powerpoint_replace_selected_text"
  | "powerpoint_format_selected_text"
  | "powerpoint_set_selected_shape_geometry"
  | "powerpoint_save";

export type UnifiedExecutionPlannerInput = {
  intent: TaskIntent;
  capabilities: CapabilitySnapshot;
  text?: string;
  root?: string;
  projectHint?: string;
  preferredLane?: ExecutionPreference;
  requiresGui?: boolean;
  requiresForeground?: boolean;
  requiresVisual?: boolean;
  dragDrop?: boolean;
  canvas?: boolean;
  nativeDialog?: boolean;
  terminalCommand?: string;
  toolName?: string;
  officeOperationType?: PlannedOfficeOperationType;
  officeHasFormatting?: boolean;
  referencePath?: string;
  templatePath?: string;
  existingPath?: string;
};

export type UnifiedRiskPlan = {
  source: "terminal-dynamic" | "capability-static" | "route-static";
  score: number;
  level: DangerLevel;
  confirmationMode: ConfirmationMode;
  reasons: string[];
  summary: string;
  staticRisk: CapabilityRisk | null;
  transactionRequired: boolean;
  grantsAuthorization: false;
};

export type UnifiedQaPlan = {
  level: OfficeQaLevel;
  source: "office-operation" | "route-verification" | "intent-policy";
  reason: string;
  visualReviewRequired: boolean;
  verification: RoutePlan["verification"];
};

export type ExecutionPlan = {
  schemaVersion: 1;
  kind: "unified-execution-plan";
  executesActions: false;
  grantsAuthorization: false;
  intent: TaskIntent;
  capabilities: CapabilitySnapshot;
  route: RoutePlan;
  lane: ExecutionRoutePlan;
  risk: UnifiedRiskPlan;
  qa: UnifiedQaPlan;
  governor: ReturnType<ToolGovernorService["advice"]>;
  intentPolicy: ReturnType<ToolGovernorService["advice"]>["intentPolicy"];
  artifact: ArtifactPlan;
  artifactPlan: ArtifactPlan;
  safety: {
    neverReplayAmbiguousExecution: boolean;
    routeRecoveryNeverRepeatsAfterAmbiguousExecution: boolean;
    hostForegroundAllowed: false;
    authorizationStillEnforcedByActionTool: true;
    userMethodConstraintsPreserved: boolean;
    criticalPhraseStillRequiredWhenRiskIsCritical: boolean;
  };
};

type LanePlanner = {
  plan(input: ExecutionRouteRequest, isolated: IsolatedLaneStatus): ExecutionRoutePlan;
};

type IsolatedStatusProvider = { status(): IsolatedLaneStatus };

type GovernorAdvisor = Pick<ToolGovernorService, "advice">;

function inferredDomain(intent: TaskIntent, route: RoutePlan): ExecutionRouteRequest["domain"] {
  if (intent.domain && intent.domain !== "auto") return intent.domain === "pdf" ? "pdf" : intent.domain;
  if (route.route.startsWith("office.")) return "office";
  if (route.route.startsWith("browser.")) return "browser";
  if (route.route.startsWith("desktop.")) return "desktop";
  if (route.route.startsWith("terminal.")) return "terminal";
  if (route.route.startsWith("intake.")) return "intake";
  if (route.route.startsWith("pdf.")) return "pdf";
  return "files";
}

function fallbackLane(input: UnifiedExecutionPlannerInput, route: RoutePlan): ExecutionRoutePlan {
  const forceIsolated = input.preferredLane === "isolated" || route.browserTarget === "isolated-browser" || Boolean(input.requiresGui || input.requiresForeground || input.requiresVisual || input.dragDrop || input.canvas || input.nativeDialog || inferredDomain(input.intent, route) === "desktop");
  const lane: ExecutionLane = forceIsolated ? "isolated" : "background";
  return {
    lane,
    preferred: input.preferredLane ?? "auto",
    available: lane === "background",
    reason: lane === "background" ? "Structured execution is Background-safe." : "The step requires isolated GUI/foreground execution; no lane service was available to confirm guest readiness.",
    hostForegroundAllowed: false,
    escalation: lane === "background" ? "isolated_if_needed" : "none",
    constraints: lane === "background" ? ["Never inject host mouse or keyboard input."] : ["Never fall back to host GUI input."],
  };
}

function genericRiskSummary(level: DangerLevel, mode: ConfirmationMode) {
  if (level === "critical") return "Critical action: exact critical confirmation phrase remains required by the action tool.";
  if (level === "high") return "High-risk action: explicit user confirmation remains required by the action tool.";
  if (level === "moderate") return "Moderate reversible/local mutation: explicit task intent can satisfy confirmation policy; transaction controls still apply.";
  if (level === "low") return "Low-risk action: normal transaction/verification controls apply.";
  return "Read-only/minimal-risk planning path.";
}

function staticRiskAssessment(input: UnifiedExecutionPlannerInput, route: RoutePlan): UnifiedRiskPlan {
  const toolMeta = input.toolName ? capabilityStaticMetadata(input.toolName, undefined) : null;
  const staticRisk = toolMeta?.risk ?? (route.readOnly ? "read-only" : null);
  let score = 8;
  const reasons: string[] = [];
  if (staticRisk === "destructive") { score = 68; reasons.push("capability_static_destructive"); }
  else if (staticRisk === "mutation") { score = 42; reasons.push("capability_static_mutation"); }
  else if (staticRisk === "reversible") { score = 28; reasons.push("capability_static_reversible"); }
  else if (staticRisk === "dynamic") { score = 20; reasons.push("dynamic_risk_requires_action_preview"); }
  else if (!route.readOnly) { score = route.requiresConfirmation ? 42 : 28; reasons.push(route.requiresConfirmation ? "route_transaction_required" : "route_reversible_mutation"); }
  else reasons.push("route_read_only");
  const level = dangerLevel(score);
  const confirmationMode = confirmationForLevel(level);
  return {
    source: input.toolName ? "capability-static" : "route-static",
    score,
    level,
    confirmationMode,
    reasons,
    summary: genericRiskSummary(level, confirmationMode),
    staticRisk: (staticRisk ?? null) as CapabilityRisk | null,
    transactionRequired: route.requiresConfirmation || !route.readOnly,
    grantsAuthorization: false,
  };
}

function terminalRiskAssessment(command: string, route: RoutePlan): UnifiedRiskPlan {
  const risk: RiskAssessment = assessTerminalRisk(command);
  return {
    source: "terminal-dynamic",
    score: risk.score,
    level: risk.level,
    confirmationMode: risk.confirmationMode,
    reasons: risk.reasons,
    summary: risk.summary,
    staticRisk: "dynamic",
    transactionRequired: true,
    grantsAuthorization: false,
  };
}

function qaPlan(input: UnifiedExecutionPlannerInput, route: RoutePlan): UnifiedQaPlan {
  if (input.officeOperationType) {
    const level = qaLevelForOperationType(input.officeOperationType, Boolean(input.officeHasFormatting));
    return {
      level,
      source: "office-operation",
      reason: level === "visual" ? "Office formatting/layout/geometry requires visual QA." : level === "structural" ? "Office content/value mutation requires structural verification." : "Office save/no-layout operation requires machine verification only.",
      visualReviewRequired: level === "visual",
      verification: route.verification,
    };
  }
  if (route.verification.kind === "visual") {
    return { level: "visual", source: "route-verification", reason: "The selected route has an explicit visual post-condition.", visualReviewRequired: true, verification: route.verification };
  }
  const description = String(input.intent.description ?? input.text ?? "").toLowerCase();
  if (route.route === "office.live.write-confirmed") {
    const looksVisual = Boolean(input.requiresVisual) || /\b(format|formatting|font|paragraph|margin|layout|page|table|geometry|position|alignment|spacing|looks?|appearance|dinh dang|căn lề|can le|bố cục|bo cuc)\b/i.test(description);
    const level: OfficeQaLevel = looksVisual ? "visual" : "structural";
    return { level, source: "intent-policy", reason: looksVisual ? "Office Live intent indicates formatting/layout or explicit visual concern." : "Office Live content mutation defaults to structural verification when no layout signal is present.", visualReviewRequired: looksVisual, verification: route.verification };
  }
  if (!route.readOnly && route.verification.kind !== "read-observation") {
    return { level: "machine", source: "route-verification", reason: "The route already defines a machine-checkable post-condition.", visualReviewRequired: false, verification: route.verification };
  }
  return { level: "machine", source: "route-verification", reason: "Read-only plan requires observation/machine verification only.", visualReviewRequired: false, verification: route.verification };
}

export class UnifiedExecutionPlanner {
  constructor(readonly dependencies: {
    router: WorkstationRouter;
    governor: GovernorAdvisor;
    executionLanes?: LanePlanner;
    isolatedAgent?: IsolatedStatusProvider;
  }) {}

  plan(input: UnifiedExecutionPlannerInput): ExecutionPlan {
    const route = this.dependencies.router.plan(input.intent, input.capabilities);
    const laneRequest: ExecutionRouteRequest = {
      preferred: route.browserTarget === "isolated-browser" ? "isolated" : input.preferredLane,
      domain: inferredDomain(input.intent, route),
      operation: input.intent.operation,
      requiresGui: input.requiresGui,
      requiresForeground: input.requiresForeground,
      requiresVisual: input.requiresVisual,
      dragDrop: input.dragDrop,
      canvas: input.canvas,
      nativeDialog: input.nativeDialog,
      description: input.intent.description,
    };
    const lane = this.dependencies.executionLanes && this.dependencies.isolatedAgent
      ? this.dependencies.executionLanes.plan(laneRequest, this.dependencies.isolatedAgent.status())
      : fallbackLane(input, route);
    const text = String(input.text ?? input.intent.description ?? `${input.intent.domain ?? "auto"} ${input.intent.operation} ${input.intent.target ?? ""}`).trim();
    const governor = this.dependencies.governor.advice({ text: text || "general workstation task", root: input.root, projectHint: input.projectHint });
    const intentPolicy = governor.intentPolicy ?? classifyIntentPolicy(text || "general workstation task");
    const risk = input.terminalCommand ? terminalRiskAssessment(input.terminalCommand, route) : staticRiskAssessment(input, route);
    const qa = qaPlan(input, route);
    const artifact = planArtifactWorkflow({
      text: text || undefined,
      target: input.intent.target,
      application: input.intent.application,
      operation: input.intent.operation,
      referencePath: input.referencePath,
      templatePath: input.templatePath,
      existingPath: input.existingPath,
      projectHint: input.projectHint,
    });
    return {
      schemaVersion: 1,
      kind: "unified-execution-plan",
      executesActions: false,
      grantsAuthorization: false,
      intent: input.intent,
      capabilities: input.capabilities,
      route,
      lane,
      risk,
      qa,
      governor,
      intentPolicy,
      artifact,
      artifactPlan: artifact,
      safety: {
        neverReplayAmbiguousExecution: true,
        routeRecoveryNeverRepeatsAfterAmbiguousExecution: route.recovery.neverRepeatAfterAmbiguousExecution,
        hostForegroundAllowed: false,
        authorizationStillEnforcedByActionTool: true,
        userMethodConstraintsPreserved: intentPolicy.methodLocked,
        criticalPhraseStillRequiredWhenRiskIsCritical: risk.confirmationMode === "critical_phrase",
      },
    };
  }
}

