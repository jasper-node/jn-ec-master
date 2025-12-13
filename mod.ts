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

// Export ENI loader utilities
export { loadEniFromXml, parseEniJson } from "./src/utils/eni-loader.ts";

// Export additional types that might be useful
export type { EniSlaveConfig, ProcessDataEntry, ProcessVariable } from "./src/types/eni-config.ts";

export type { PdoMapping } from "./src/types/ec_types.ts";
export type { CycleLoopController, CycleLoopOptions, CycleStats } from "./src/utils/cycle-loop.ts";
export { createCycleLoop } from "./src/utils/cycle-loop.ts";
