// Main entry point for the package
export { AlStatusCode, EcMaster, RegisterAddress, SlaveState } from "./src/ec_master.ts";

// Export types
export type { EmergencyEvent, EniConfig, StateChangeEvent } from "./src/ec_master.ts";

// Export error classes
export {
  EtherCatError,
  FfiError,
  PdoIntegrityError,
  StateTransitionError,
} from "./src/types/errors.ts";
export type { ErrorContext } from "./src/types/errors.ts";

// Export ENI loader utilities
export { loadEniFromXml, parseEniJson } from "./src/utils/eni-loader.ts";

// Export slave resolution utilities
export { findSlaveIndex, resolveSlaves } from "./src/utils/resolve-slaves.ts";
export type { ResolvedSlave, SlaveVariable } from "./src/utils/resolve-slaves.ts";

// Export additional types that might be useful
export type {
  EniSlaveConfig,
  ProcessDataEntry,
  ProcessDataMapping,
  ProcessVariable,
} from "./src/types/eni-config.ts";

export type { PdoMapping } from "./src/types/ec_types.ts";
