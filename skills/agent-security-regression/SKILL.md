---
name: agent-security-regression
description: Run local adversarial regression cases for indirect prompt injection, malicious tool metadata, secret-exfiltration language and confirmation-suppression attempts. Designed as a lightweight NHD counterpart to AgentDojo-style security evaluation.
---

# Agent Security Regression

Use after changing browser/document intake, MCP tool descriptions, risk policy, task authorization, or external-tool integrations.

## Workflow
1. Run `node skills/agent-security-regression/scripts/run.mjs`.
2. All malicious cases must be detected as high/critical.
3. Benign business/document instructions must not be promoted to high/critical.
4. Pair this with the normal full MCP regression suite; this benchmark does not grant permission to execute any attack payload.

The benchmark corpus is synthetic and local. It evaluates detection/control semantics only; it does not attack external systems.
