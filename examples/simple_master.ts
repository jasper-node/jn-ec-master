/**
 * This example reads ENI file if provided. If not runs a discovery and uses default configuration.
 * Finds first slave with inputs and monitors input 1 state.
 * Finds the first slave with outputs and writes to output 1 equals to input 1 state.
 * Runs the cycle and prints the input and output states on change.
 * Stops and cleans up the master after 30 seconds.
 *
 * Provides very basic logs to the console.
 */
import { EniConfig } from "../src/types/eni-config.ts";
import { EcMaster, SlaveState } from "../src/ec_master.ts";
import { createCycleLoop } from "@controlx-io/cycle-loop";
import { PdoMapping } from "../src/types/ec_types.ts";

// Parse arguments: first arg can be ENI file path or interface name
let configFile: string | undefined;
let interfaceName: string;

if (Deno.args.length > 0) {
  const firstArg: string = Deno.args[0]!;
  // Check if first argument is a file path
  try {
    const stat = await Deno.stat(firstArg);
    if (stat.isFile) {
      configFile = firstArg;
      interfaceName = Deno.args[1] || "eth0";
    } else {
      // Not a file, treat as interface name
      interfaceName = firstArg;
    }
  } catch {
    // File doesn't exist, treat as interface name
    interfaceName = firstArg;
  }
} else {
  interfaceName = "eth0"; // Default to eth0 if not provided
}

let config: EniConfig;
if (configFile) {
  // Load ENI from file if provided
  const { loadEniFromXml, parseEniJson } = await import("../src/utils/eni-loader.ts");
  if (configFile.endsWith(".xml")) {
    config = await loadEniFromXml(configFile);
  } else {
    config = await parseEniJson(configFile);
  }
  config.master.runtimeOptions.networkInterface = interfaceName;
} else {
  // Run discovery if no ENI file provided
  config = await EcMaster.discoverNetwork(interfaceName);
}

for (const slave of config.slaves) {
  console.log(`Slave ${slave.name}`);
}

config.slaves.forEach((slave, index) => {
  if (slave.name === "EL1809") {
    slave.initCommands = slave.initCommands || [];

    // Configure all 16 channels (0x8000 to 0x80F0)
    for (let ch = 0; ch < 16; ch++) {
      slave.initCommands.push({
        slaveIndex: index,
        transition: ["PS"],
        type: "sdo",
        index: 0x8000 + (ch * 0x10),
        subIndex: 6,
        data: "02",
        comment: `Debounce Ch${ch + 1} 100ms`,
      });
    }
  }
});

// config.master.cycleTime = 100_000; // 100ms cycle time
const useBufferFlag = Deno.args.includes("--buffer");

// IMPORTANT: When using cycle times > 100ms, you must configure the SM watchdog timeout.
// The default SM watchdog is ~100ms, which will reset outputs to safe state (0) if
// no valid process data is received within that time.
// Set watchdogTimeoutMs to at least 2x your cycle time (in ms) for safety margin.
// config.master.cycleTime = 1_000_000; // 1s cycle time
// config.master.watchdogTimeoutMs = 2_000; // 2 seconds watchdog timeout

const master = new EcMaster(config);
await master.initialize();
await master.requestState(SlaveState.INIT);
await master.requestState(SlaveState.PRE_OP);
// Watchdog timeout is automatically configured during PRE-OP -> SAFE-OP transition
await master.requestState(SlaveState.SAFE_OP);
await master.requestState(SlaveState.OP);

// If ENI is provided, verify topology
if (configFile) {
  try {
    await master.verifyTopology();
    console.log("✓ Topology verified");
  } catch (_error) {
    console.error("Topology mismatch! Run without ENI file to discover network.");
    master.close();
    Deno.exit(1);
  }
}

// Get mappings to find slave index for outputs
const mappings = master.getMappings();
// find first input in the mappings
const firstInput = Array.from(mappings.values()).find((mapping) => mapping.isInput);
let lastValue = false;

if (!firstInput) {
  console.error("No digital input variables found in configuration");
  master.close();
  Deno.exit(1);
}

console.log(`First input: ${firstInput?.variableName}`);
console.log(`First input props: ${JSON.stringify(firstInput)}`);

// find first output in the mappings
const firstOutput = Array.from(mappings.values()).find((mapping) => !mapping.isInput);

if (!firstOutput) {
  console.warn("No digital output variables found - will only monitor inputs");
} else {
  console.log(`First output: ${firstOutput?.variableName}`);
  console.log(`First output props: ${JSON.stringify(firstOutput)}`);
}

// Function to process tags (read digital inputs and write digital outputs)
function processTags() {
  if (!firstInput) return;

  if (useBufferFlag) {
    useBuffer([firstInput.pdiByteOffset, firstInput.bitOffset ?? 0], [
      firstOutput?.pdiByteOffset,
      firstOutput?.bitOffset,
    ]);
  } else useVariableMappings(firstInput, firstOutput);
}

function useVariableMappings(firstInput: PdoMapping, firstOutput?: PdoMapping) {
  if (lastValue !== firstInput.currentValue) {
    console.log(
      `${firstInput.variableName} changed from ${lastValue} to ${firstInput.currentValue}`,
    );
    lastValue = firstInput.currentValue as boolean;
  }

  if (!firstOutput) return;
  firstOutput.newValue = firstInput.currentValue as boolean;
}

function useBuffer(
  [byteOffset, bitOffset]: [number, number],
  [outputByteOffset, outBitOffset]: [number | undefined, number | undefined],
) {
  // get the process data from the buffer
  // get the byte offset and bit offset for the first input and read the new value
  const buf = master.getProcessDataBuffer();

  const byteVal = buf[byteOffset] ?? 0;
  const newVal = ((byteVal >> bitOffset) & 1) === 1;

  if (lastValue !== newVal) {
    console.log(
      `Buffer ${byteOffset}:${bitOffset} changed from ${lastValue} to ${newVal}`,
    );
    lastValue = newVal;
  }

  if (outputByteOffset == null || outBitOffset == null) return;

  // set newVal to the firstOutput appropriate byte in the buffer
  const outputByteVal = buf[outputByteOffset] ?? 0;
  // Clear the bit first, then set it if needed
  buf[outputByteOffset] = (outputByteVal & ~(1 << outBitOffset)) |
    ((newVal ? 1 : 0) << outBitOffset);
}

// Create cycle loop
const cycleController = createCycleLoop({
  cycleTimeMs: (config.master.cycleTime || 10000) / 1000, // Convert from microseconds to milliseconds
  cycleFn: async () => {
    // Run the cycle and return WKC
    const wkc = await master.runCycle();
    // Process tags after each cycle
    processTags();
    return wkc;
  },
  onError: (error) => {
    console.error("Cycle error:", error);
    cycleController.stop();
    master.close();
    Deno.exit(1);
  },
});

// Start the cycle loop
console.log("Starting cycle loop...");
cycleController.start();

// Handle Ctrl+C gracefully
Deno.addSignalListener("SIGINT", () => {
  console.log("\nStopping...");
  cycleController.stop();
  master.requestState(SlaveState.INIT).then(() => {
    master.close();
    Deno.exit(0);
  });
});

// Stop after 30 seconds
setTimeout(async () => {
  console.log("Stopping after 30 seconds...");
  cycleController.stop();
  await master.requestState(SlaveState.INIT);
  master.close();
  Deno.exit(0);
}, 30000);
