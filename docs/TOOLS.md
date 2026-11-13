# MCP Tools

The tool inventory is no longer maintained by hand in this file. Hard-coded counts become stale as the MCP evolves.

Authoritative sources:

- Registration ownership: `src/mcp-registries/*.ts`
- Capability metadata/policy: `src/capability-registry.ts`
- Generated human-readable catalog: `docs/generated/CAPABILITIES.md`
- Generated machine-readable catalog: `docs/generated/capability-catalog.json`
- Generated architecture contract: `docs/generated/ARCHITECTURE.md`
- Live runtime inventory: local `/api/tools` or `tool_governor` with `action=capabilities`

Regenerate source documentation after a build with:

```powershell
npm run build
npm run docs:architecture
```

Verify that generated documentation has not drifted from source with:

```powershell
npm run test:architecture
```

Generated documentation is development and CI evidence. Live runtime identity, Fast Health, and the runtime capability inventory remain authoritative for the deployed process.
