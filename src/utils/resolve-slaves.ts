import { EniConfig } from "../types/eni-config.ts";

/**
 * A process variable resolved to its owning slave.
 */
export interface SlaveVariable {
  /** Entry name without slave prefix (e.g., "Output_PDO_0") */
  name: string;
  /** Full variable name as keyed in getMappings() (e.g., "XI211208.Output_PDO_0") */
  fullName: string;
  dataType: string;
  bitSize: number;
  isInput: boolean;
  /** SDO index from processData.entries, if available */
  sdoIndex?: number;
  /** SDO subIndex from processData.entries, if available */
  sdoSubIndex?: number;
}

/**
 * A slave with its variables resolved from both processImage and processData.entries.
 */
export interface ResolvedSlave {
  /** Device name from EEPROM (e.g., "XI211208") */
  name: string;
  /** Position in slaves array (0-based) */
  index: number;
  physAddr?: number;
  vendorId?: number;
  productCode?: number;
  variables: SlaveVariable[];
}

/**
 * Produce a slave-centric view by merging slaves[] with processImage variables.
 *
 * Useful for:
 * - UI: render slave list, click to show available variables
 * - Validation: check that tag mappings reference valid slave+entry pairs
 * - Default mapping: generate tags for all variables when tags[] is omitted
 *
 * Variables are matched to slaves by name prefix ({slaveName}.{entryName}).
 * SDO index/subIndex are enriched from processData.entries when available.
 */
export function resolveSlaves(config: EniConfig): ResolvedSlave[] {
  // Build a lookup from slave name → entry name → SDO info (from processData.entries)
  const sdoLookup = new Map<string, Map<string, { index: number; subIndex: number }>>();
  for (const slave of config.slaves) {
    if (slave.processData?.entries) {
      const entryMap = new Map<string, { index: number; subIndex: number }>();
      for (const entry of slave.processData.entries) {
        entryMap.set(entry.name, { index: entry.index, subIndex: entry.subIndex });
      }
      sdoLookup.set(slave.name, entryMap);
    }
  }

  // Build per-slave variable lists from processImage
  const slaveVariableMap = new Map<string, SlaveVariable[]>();

  if (config.processImage) {
    const addVariables = (
      variables: { name: string; dataType: string; bitSize: number }[],
      isInput: boolean,
    ) => {
      for (const v of variables) {
        const dotIndex = v.name.indexOf(".");
        if (dotIndex <= 0) continue;

        const slaveName = v.name.substring(0, dotIndex);
        const entryName = v.name.substring(dotIndex + 1);

        if (!slaveVariableMap.has(slaveName)) {
          slaveVariableMap.set(slaveName, []);
        }

        const sdoInfo = sdoLookup.get(slaveName)?.get(entryName);

        slaveVariableMap.get(slaveName)!.push({
          name: entryName,
          fullName: v.name,
          dataType: v.dataType,
          bitSize: v.bitSize,
          isInput,
          sdoIndex: sdoInfo?.index,
          sdoSubIndex: sdoInfo?.subIndex,
        });
      }
    };

    addVariables(config.processImage.outputs.variables, false);
    addVariables(config.processImage.inputs.variables, true);
  }

  return config.slaves.map((slave, index) => ({
    name: slave.name,
    index,
    physAddr: slave.physAddr,
    vendorId: slave.vendorId,
    productCode: slave.productCode,
    variables: slaveVariableMap.get(slave.name) ?? [],
  }));
}

/**
 * Find a slave's 0-based index by name.
 * Returns -1 if not found.
 *
 * Useful for SDO tag resolution: convert tag.slave name to the slaveIndex
 * needed by sdoRead() / sdoWrite().
 */
export function findSlaveIndex(config: EniConfig, slaveName: string): number {
  return config.slaves.findIndex((s) => s.name === slaveName);
}
