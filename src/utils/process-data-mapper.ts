import { EniConfig, ProcessDataMapping } from "../types/eni-config.ts";

/**
 * Match a processImage variable to a slave by checking explicit address ranges.
 * Robust against gaps, alignment padding, and out-of-order definitions.
 * Uses the ENI file's <ProcessData><Recv><BitStart> and <BitLength> as the source of truth.
 */
function matchVariableToSlave(
  bitOffset: number, // Bit offset relative to the Image Section (Input or Output)
  isInput: boolean,
  slaves: EniConfig["slaves"],
): number {
  for (let i = 0; i < slaves.length; i++) {
    const slave = slaves[i];
    if (!slave || !slave.processData) continue;

    // Determine the range for this slave in this section
    const byteOffset = isInput ? slave.processData.inputOffset : slave.processData.outputOffset;

    const bitLength = isInput
      ? slave.processData.inputBitLength
      : slave.processData.outputBitLength;

    if (byteOffset === undefined || bitLength === undefined) continue;

    const startBit = byteOffset * 8;
    const endBit = startBit + bitLength;

    // Strict Bounds Check: Is the variable inside this slave's range?
    if (bitOffset >= startBit && bitOffset < endBit) {
      return i; // Found the owner
    }
  }
  return -1;
}

/**
 * Build process data mappings from ENI configuration.
 * Uses processImage.variables as the primary source of truth (they have correct global bitOffsets).
 * Matches variables to slaves by checking explicit address ranges from ENI file.
 */
export function buildProcessDataMappings(
  eniConfig: EniConfig,
): Map<string, ProcessDataMapping> {
  const mappings = new Map<string, ProcessDataMapping>();

  if (!eniConfig.processImage) return mappings;

  const outputSize = eniConfig.processImage.outputs.byteSize;

  // 1. Process Outputs (Master -> Slave)
  eniConfig.processImage.outputs.variables.forEach((v) => {
    // Byte offset relative to PDI start (Outputs are first)
    const pdiByteOffset = Math.floor(v.bitOffset / 8);

    const slaveIndex = matchVariableToSlave(v.bitOffset, false, eniConfig.slaves);

    if (slaveIndex >= 0) {
      mappings.set(v.name, {
        variableName: v.name,
        pdiByteOffset: pdiByteOffset,
        bitOffset: v.dataType === "BOOL" ? (v.bitOffset % 8) : undefined,
        dataType: v.dataType,
        slaveIndex: slaveIndex + 1, // 1-based for API
        isInput: false,
        bitSize: v.bitSize,
      });
    }
  });

  // 2. Process Inputs (Slave -> Master)
  eniConfig.processImage.inputs.variables.forEach((v) => {
    // Byte offset relative to PDI start: Add Output Size
    const pdiByteOffset = outputSize + Math.floor(v.bitOffset / 8);

    const slaveIndex = matchVariableToSlave(v.bitOffset, true, eniConfig.slaves);

    if (slaveIndex >= 0) {
      mappings.set(v.name, {
        variableName: v.name,
        pdiByteOffset: pdiByteOffset,
        bitOffset: v.dataType === "BOOL" ? (v.bitOffset % 8) : undefined,
        dataType: v.dataType,
        slaveIndex: slaveIndex + 1,
        isInput: true,
        bitSize: v.bitSize,
      });
    }
  });

  return mappings;
}
