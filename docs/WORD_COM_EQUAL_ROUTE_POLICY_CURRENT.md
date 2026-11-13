# NHD Word COM Equal-Route Policy — Current

## Decision

PowerShell/Word COM and Office Live are both valid execution routes for Word work. Office Live remains available as a fast, fingerprinted route, but it is no longer mandatory merely because it can express the requested operation.

## Terminal behavior

- Routine Word COM is no longer rejected with `DIRECT_WORD_ROUTE_REQUIRED`.
- Word COM uses the same requested timeout rules as other Terminal commands; there is no Word-specific 30-second clamp.
- `terminalPolicy` is reported as `standard`.
- Successful Terminal/COM mutations may still report `officeMutationHint` for audit/verification metadata.

## Safety retained

This change does **not** bypass MCP safety controls. The following remain in force:

- Terminal preview -> one-time token -> execute transaction.
- Risk classification and required user confirmation/critical phrase where applicable.
- Emergency Stop and `terminalEnabled` checks.
- Task-scoped authorization rules.
- `Invoke-Expression` / `IEX` remain blocked.
- Standalone PowerShell script runner restrictions remain in force to avoid quoting/encoding ambiguity.
- UTF-8-safe `EncodedCommand` behavior remains in force.
- Ambiguous or failed actions are not automatically replayed.

## Route selection

The caller may choose Office Live or PowerShell/Word COM based on the task. Office Live may still be recommended for operations where its fingerprint/verification transaction is useful, but the governor must not hard-block Terminal/COM solely because Office Live can perform the same edit.

The historical `WORD_DIRECT_EXECUTION_POLICY_v0.18.2.md` remains unchanged as a record of the earlier forced-routing policy.
