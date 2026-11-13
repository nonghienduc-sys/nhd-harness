import { TinyRouteClassifier, type TinyRouteLabel } from "./tiny-router.js";

export type LocalIntelligenceTier = "rules" | "semantic" | "tiny" | "direct" | "cloud";
export type LocalIntent =
  | "status"
  | "open"
  | "search"
  | "read"
  | "classify"
  | "extract"
  | "transform"
  | "edit"
  | "navigate"
  | "execute"
  | "plan"
  | "analyze"
  | "research"
  | "general";

export type LocalRouteInput = {
  text: string;
  operationHint?: string;
  domainHint?: string;
  externalSideEffect?: boolean;
};

export type LocalRouteDecision = {
  intent: LocalIntent;
  tier: LocalIntelligenceTier;
  target: "nhd-rule-engine" | "nhd-semantic-router" | "nhd-context-gate" | "nhd-direct-tool" | "chatgpt-cloud";
  confidence: number;
  latencyBudgetMs: number | null;
  reasons: string[];
  policyGateRequired: boolean;
  mayExecute: false;
  escalation: {
    required: boolean;
    when: string[];
  };
};

export type LocalDispatchLane = "direct_tool" | "context_gate" | "cloud";

export type LocalDispatchDecision = {
  lane: LocalDispatchLane;
  route: LocalRouteDecision;
  reason: string;
  directPathPreserved: true;
  localModelRequired: false;
  automaticExecution: false;
  mayExecute: false;
  policyGateRequired: boolean;
  fallback: "direct_tool" | "cloud" | null;
};

export type LocalVerificationInput = {
  tier: LocalIntelligenceTier;
  confidence: number;
  externalSideEffect?: boolean;
  ambiguous?: boolean;
  postConditionVerified?: boolean;
  evidenceCount?: number;
};

export type LocalVerificationResult = {
  verdict: "accept_local" | "reobserve" | "require_policy_gate" | "escalate_cloud";
  reasons: string[];
  mayExecute: false;
  taskMetadataIsAuthorization: false;
  replayAmbiguousActions: false;
};

export type LocalIntelligenceStatus = {
  available: true;
  mode: "deterministic-tiny-router";
  architecture: "NHD Direct Fast Lane + Tiny Router + Cloud Escalation";
  autonomousExecution: false;
  modelInvocationEnabled: false;
  automaticModelRouting: false;
  directFastLanePreserved: true;
  deterministicRouting: true;
  verificationGate: true;
  escalationEnabled: true;
  tinyRouter: { enabled: true; kind: "character-trigram-naive-bayes"; trainingExamples: number; modelInvocation: false };
  localModelRuntime: "disabled";
  safety: {
    nhdTaskRuntimeIsAuthority: true;
    nhdRiskPolicyIsAuthority: true;
    localOutputIsAuthorization: false;
    externalModelEndpointsUsed: false;
    ambiguousActionsNeverReplayed: true;
  };
};

export type LocalIntelligenceOptions = Record<string, unknown>;

const clampConfidence = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const normalize = (value: string) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const normalizeMatch = (value: string) => normalize(value)
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d");

export class LocalIntelligenceService {
  private readonly tinyRouter = new TinyRouteClassifier();

  constructor(_options: LocalIntelligenceOptions = {}) {}

  status(): LocalIntelligenceStatus {
    return {
      available: true,
      mode: "deterministic-tiny-router",
      architecture: "NHD Direct Fast Lane + Tiny Router + Cloud Escalation",
      autonomousExecution: false,
      modelInvocationEnabled: false,
      automaticModelRouting: false,
      directFastLanePreserved: true,
      deterministicRouting: true,
      verificationGate: true,
      escalationEnabled: true,
      tinyRouter: { enabled: true, kind: "character-trigram-naive-bayes", trainingExamples: this.tinyRouter.trainingExamples, modelInvocation: false },
      localModelRuntime: "disabled",
      safety: {
        nhdTaskRuntimeIsAuthority: true,
        nhdRiskPolicyIsAuthority: true,
        localOutputIsAuthorization: false,
        externalModelEndpointsUsed: false,
        ambiguousActionsNeverReplayed: true,
      },
    };
  }

  route(input: LocalRouteInput): LocalRouteDecision {
    const text = normalize(input.text);
    if (!text) throw new Error("text is required.");
    const hint = normalize(`${input.domainHint ?? ""} ${input.operationHint ?? ""}`);
    const combined = `${text} ${hint}`.trim();
    const matchText = normalizeMatch(combined);
    const reasons: string[] = [];
    const policyGateRequired = Boolean(input.externalSideEffect) || this.looksMutating(matchText);

    if (input.externalSideEffect) reasons.push("explicit_external_side_effect");

    if (this.isDeepCloudTask(matchText)) {
      reasons.push("deep_or_fresh_reasoning");
      return this.decision("research", "cloud", 0.96, reasons, policyGateRequired);
    }

    if (this.isContextDependent(matchText)) {
      reasons.push("context_dependent_requires_task_memory");
      return this.decision("plan", "semantic", 0.9, reasons, policyGateRequired, "nhd-context-gate", 40);
    }

    if (this.isSimpleStatus(matchText)) {
      reasons.push("deterministic_status_command");
      return this.decision("status", "rules", 0.99, reasons, policyGateRequired);
    }

    if (this.looksMultiStep(matchText)) {
      reasons.push("multi_step_direct_mcp_workflow");
      return this.decision("plan", "direct", 0.9, reasons, policyGateRequired);
    }

    if (this.isSimpleOpen(matchText)) {
      reasons.push("deterministic_open_or_navigation_command");
      return this.decision("open", "rules", 0.98, reasons, policyGateRequired);
    }

    if (policyGateRequired && /\b(?:word live|office live|excel live|powerpoint live)\b/i.test(matchText)) {
      reasons.push("live_office_mutation_uses_direct_mcp_and_policy_gate");
      return this.decision("edit", "direct", 0.9, reasons, true);
    }

    if (this.isTinyClassificationTask(matchText)) {
      reasons.push("tiny_classifier_task");
      return this.decision("classify", "tiny", 0.92, reasons, policyGateRequired);
    }

    if (this.isTextGenerationTask(matchText)) {
      reasons.push("text_generation_requires_chatgpt_no_local_model");
      const intent: LocalIntent = /\b(?:extract|trich xuat|parse|json|field|metadata)\b/i.test(matchText) ? "extract" : "transform";
      return this.decision(intent, "cloud", 0.94, reasons, policyGateRequired);
    }

    if (this.isSemanticRetrieval(matchText)) {
      reasons.push("retrieval_or_project_resolution");
      return this.decision("search", "semantic", 0.94, reasons, policyGateRequired);
    }

    if (policyGateRequired) {
      reasons.push("mutation_uses_direct_mcp_and_existing_policy_gate");
      return this.decision("edit", "direct", 0.84, reasons, true);
    }

    const prediction = this.tinyRouter.predict(matchText);
    reasons.push("tiny_character_trigram_fallback", `tiny_margin_${prediction.marginPerGram.toFixed(4)}`);
    return this.decisionForTinyPrediction(prediction.label, prediction.confidence, reasons);
  }

  dispatch(input: LocalRouteInput): LocalDispatchDecision {
    const route = this.route(input);
    const base = {
      route,
      directPathPreserved: true as const,
      localModelRequired: false as const,
      automaticExecution: false as const,
      mayExecute: false as const,
      policyGateRequired: route.policyGateRequired,
    };

    if (route.target === "nhd-context-gate") {
      return { lane: "context_gate", reason: "Resolve durable task/project context before choosing any action.", fallback: "direct_tool", ...base };
    }
    if (route.tier === "cloud") {
      return { lane: "cloud", reason: "The task needs ChatGPT reasoning or text generation; no local model hop exists.", fallback: null, ...base };
    }
    return {
      lane: "direct_tool",
      reason: route.tier === "tiny"
        ? "Use the tiny classifier only for routing/classification, then continue through the normal MCP/tool path."
        : "Use the original ChatGPT Web -> MCP -> Skill/Tool path with no local-model hop.",
      fallback: null,
      ...base,
    };
  }

  verify(input: LocalVerificationInput): LocalVerificationResult {
    const confidence = clampConfidence(input.confidence);
    const reasons: string[] = [];
    const base = {
      mayExecute: false as const,
      taskMetadataIsAuthorization: false as const,
      replayAmbiguousActions: false as const,
    };

    if (input.ambiguous) {
      reasons.push("ambiguous_outcome_must_not_be_replayed");
      return { verdict: "reobserve", reasons, ...base };
    }
    if (input.externalSideEffect) {
      reasons.push("external_side_effect_requires_existing_nhd_policy_gate");
      return { verdict: "require_policy_gate", reasons, ...base };
    }
    if (input.postConditionVerified === false) {
      reasons.push("post_condition_not_verified");
      return { verdict: "reobserve", reasons, ...base };
    }
    if (input.tier === "cloud") {
      reasons.push("decision_already_escalated_to_cloud");
      return { verdict: "escalate_cloud", reasons, ...base };
    }

    const threshold = input.tier === "rules" ? 0.9
      : input.tier === "semantic" ? 0.84
      : input.tier === "tiny" ? 0.82
      : 0.84;

    if (confidence < threshold) {
      reasons.push(`confidence_below_${threshold.toFixed(2)}_threshold`);
      return { verdict: "escalate_cloud", reasons, ...base };
    }
    if ((input.evidenceCount ?? 1) < 1) {
      reasons.push("no_verification_evidence");
      return { verdict: "reobserve", reasons, ...base };
    }
    reasons.push("confidence_and_verification_sufficient_for_local_advice");
    return { verdict: "accept_local", reasons, ...base };
  }

  private decisionForTinyPrediction(label: TinyRouteLabel, confidence: number, reasons: string[]): LocalRouteDecision {
    if (label === "rules") return this.decision("navigate", "rules", confidence, reasons, false);
    if (label === "semantic") return this.decision("search", "semantic", confidence, reasons, false);
    if (label === "tiny") return this.decision("classify", "tiny", confidence, reasons, false);
    if (label === "direct_tool") return this.decision("plan", "direct", confidence, reasons, false);
    return this.decision("general", "cloud", confidence, reasons, false);
  }

  private decision(intent: LocalIntent, tier: LocalIntelligenceTier, confidence: number, reasons: string[], policyGateRequired: boolean, targetOverride?: LocalRouteDecision["target"], latencyOverrideMs?: number | null): LocalRouteDecision {
    const target = targetOverride ?? (tier === "rules" ? "nhd-rule-engine"
      : tier === "semantic" ? "nhd-semantic-router"
      : tier === "tiny" ? "nhd-direct-tool"
      : tier === "direct" ? "nhd-direct-tool"
      : "chatgpt-cloud");
    const latencyBudgetMs = latencyOverrideMs !== undefined ? latencyOverrideMs
      : tier === "rules" ? 5
      : tier === "semantic" ? 40
      : tier === "tiny" ? 5
      : tier === "direct" ? 10
      : null;
    const threshold = tier === "rules" ? 0.9 : tier === "semantic" ? 0.84 : tier === "tiny" ? 0.82 : tier === "direct" ? 0.84 : 0.72;
    return {
      intent,
      tier,
      target,
      confidence: clampConfidence(confidence),
      latencyBudgetMs,
      reasons: [...new Set(reasons)],
      policyGateRequired,
      mayExecute: false,
      escalation: {
        required: tier === "cloud" || confidence < threshold,
        when: ["confidence below tier threshold", "fresh/current public information is required", "text generation or deep reasoning is required", "verification remains ambiguous", "NHD policy requires user confirmation"],
      },
    };
  }

  private isSimpleStatus(text: string) {
    return /^(?:status|health|trang thai|mcp status|check(?: the)? mcp health|check health|kiem tra).{0,24}(?:ket noi|connection|mcp|health|trang thai)(?:\b|$)/i.test(text)
      || /^(?:status|health|mcp status)(?:\b|$)/i.test(text);
  }

  private isSimpleOpen(text: string) {
    return /^(?:mo|open|activate|focus)(?:\s+(?:giup|cho|vao|giup toi|cho toi)){0,2}\s*.{0,18}\b(?:word|excel|powerpoint|folder|thu muc|coc coc)(?:\b|$)/i.test(text)
      || /^(?:mo|open)\s+(?:project\s+folder|folder|thu muc)(?:\b|$)/i.test(text);
  }

  private isContextDependent(text: string) {
    return /^(?:lam di|lam tiep|tiep tuc|xac nhan|kiem tra lai|thu lai|tiep theo|gio tiep theo|gio .*lam gi)(?:\b|$)/i.test(text);
  }

  private isSemanticRetrieval(text: string) {
    return /\b(?:tim|find|search|locate|latest|moi nhat|hom qua|project|du an|file|document|tai lieu|memory|checkpoint|resume|khoi phuc|lich su chat)\b/i.test(text)
      && !this.isDeepCloudTask(text);
  }

  private isTinyClassificationTask(text: string) {
    return /\b(?:classify|phan loai|intent|route intent|tag request|label request|gan nhan|nhan dien loai|tool category|domain classification)\b/i.test(text)
      && !/\b(?:extract|trich xuat|parse|json|field|metadata)\b/i.test(text);
  }

  private isTextGenerationTask(text: string) {
    return /\b(?:extract|trich xuat|parse|json|field|metadata|summari[sz]e|tom tat|rewrite|viet lai|translate|dich|normalize|chuyen van phong|rut gon|polish)\b/i.test(text);
  }

  private looksMultiStep(text: string) {
    if (/\b(?:sau do|then|after that|tiep theo|buoc|plan|ke hoach)\b/i.test(text)) return true;
    const actions = text.match(/\b(?:mo|open|tim|find|search|doc|read|sua|chinh|edit|fill|dien|save|luu|verify|kiem tra|check|tom tat|summari[sz]e|dich|translate|so sanh|compare|cap nhat|update|restart|phan loai|classify|extract|tiep tuc)\b/gi) ?? [];
    const connector = /\b(?:va|and|roi|then|sau do)\b/i.test(text);
    return actions.length >= 2 && connector;
  }

  private looksMutating(text: string) {
    return /\b(?:sua|chinh|edit|write|ghi|xoa|delete|move|rename|send|submit|upload|login|password|payment|transfer|purchase|call|execute|run|restart|save|luu|fill|dien|click|cap nhat|update)\b/i.test(text);
  }

  private isDeepCloudTask(text: string) {
    if (/\b(?:nghien cuu|research|latest news|tin moi|tin tuc|hom nay|web search|tra tren mang|tra web|paper|phap ly|legal|medical|y khoa|financial analysis|phan tich sau|deep analysis|chien luoc|strategy|so sanh toan dien|comprehensive)\b/i.test(text)) return true;
    if (/\b(?:quy dinh|chinh sach|luat|model|benchmark|gia|thi truong|stock market|openai)\b.{0,32}\b(?:moi nhat|hien tai|hien hanh|current|latest|hom nay)\b/i.test(text)) return true;
    if (/\b(?:moi nhat|hien tai|hien hanh|current|latest|hom nay)\b.{0,32}\b(?:quy dinh|chinh sach|luat|model|benchmark|gia|thi truong|stock market|openai)\b/i.test(text)) return true;
    if (/^tim hieu(?: sau)?\b/i.test(text) && !/\b(?:project|file|document|tai lieu|memory|checkpoint)\b/i.test(text)) return true;
    return false;
  }
}
