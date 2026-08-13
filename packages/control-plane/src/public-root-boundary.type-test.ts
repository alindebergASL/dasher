import type { AgentRunRepositoryConfig } from "@dasher/control-plane";
import type * as PackageRoot from "@dasher/control-plane";
import type {
  AgentRunOperatorRepositoryConfig,
  ClaimAgentRunInput,
  ReconcileAttemptInput,
} from "@dasher/control-plane/agent-run-types";

// The tenant repository contract remains available at the application root.
const tenantConfig = null as unknown as AgentRunRepositoryConfig;
void tenantConfig;

// Operator-only contracts are compile-time inaccessible from the package root.
// @ts-expect-error operator configuration is restricted to the subpath
type RootOperatorConfig = PackageRoot.AgentRunOperatorRepositoryConfig;
// @ts-expect-error claim input is restricted to the subpath
type RootClaimInput = PackageRoot.ClaimAgentRunInput;
// @ts-expect-error reconciliation input is restricted to the subpath
type RootReconcileInput = PackageRoot.ReconcileAttemptInput;

type SubpathContracts = readonly [
  AgentRunOperatorRepositoryConfig,
  ClaimAgentRunInput,
  ReconcileAttemptInput,
];
const restrictedContracts = null as unknown as SubpathContracts;
void restrictedContracts;
void (null as unknown as RootOperatorConfig);
void (null as unknown as RootClaimInput);
void (null as unknown as RootReconcileInput);
