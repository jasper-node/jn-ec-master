import { EcMaster, SlaveState } from "../src/ec_master.ts";
import { loadEniFromXml, parseEniJson } from "../src/utils/eni-loader.ts";

async function main() {
  // Parse command line arguments
  const args = Deno.args;
  const fastFlag = args.includes("--fast");
  const nonFlagArgs = args.filter((arg) => !arg.startsWith("--"));
  const configFile = nonFlagArgs[0];
  const interfaceName = nonFlagArgs[1] || "eth0"; // Default to eth0 if not provided

  if (!configFile) {
    console.error(
      "Usage: deno run -A --unstable-ffi examples/cycle_eni_config.ts <path-to-eni-xml-or-json> [interface] [--fast]",
    );
    Deno.exit(1);
  }

  try {
    // Load ENI config
    let eniConfig;
    if (configFile.endsWith(".xml")) {
      console.log(`Loading ENI from XML: ${configFile}`);
      eniConfig = await loadEniFromXml(configFile);
    } else {
      console.log(`Loading ENI from JSON: ${configFile}`);
      eniConfig = await parseEniJson(configFile);
    }

    // Override interface if provided
    if (interfaceName) {
      eniConfig.master.runtimeOptions.networkInterface = interfaceName;
    }

    // Override cycleTime if --fast flag is used
    if (fastFlag) {
      const originalCycleTime = eniConfig.master.cycleTime || 1000;
      eniConfig.master.cycleTime = 1000; // 1ms in microseconds
      console.warn(
        `⚠️  WARNING: --fast flag detected. cycleTime from config (${originalCycleTime}us) is ignored and set to 1ms (1000us)`,
      );
    }

    console.log(
      `Initializing EtherCAT Master on ${eniConfig.master.runtimeOptions.networkInterface}...`,
    );

    const master = new EcMaster(eniConfig);

    // Event handlers
    master.on("stateChange", (event) => {
      console.log(
        `State changed: ${event.previousState} -> ${event.currentState}`,
      );
    });

    master.on("emergency", (event) => {
      console.error(
        `Emergency from slave ${event.slaveId}: Code ${
          event.errorCode.toString(16)
        } Reg ${event.errorReg}`,
      );
    });

    try {
      // Initialize (discovers network, sets up PDI)
      await master.initialize();
      console.log("Initialization successful.");

      // Feature 302: Verify topology
      await master.verifyTopology();
      console.log("✓ Topology verified");

      // Feature 104: State machine
      console.log("Requesting PRE_OP...");
      await master.requestState(SlaveState.PRE_OP);
      console.log("Requesting SAFE_OP...");
      await master.requestState(SlaveState.SAFE_OP);
      console.log("Requesting OP...");
      await master.requestState(SlaveState.OP);

      // Feature 201: Cyclic operation with shared memory
      const cycleTime = eniConfig.master.cycleTime || 1000;
      const cycleTimeMs = cycleTime / 1000;

      console.log(`Starting cyclic loop (cycle time: ${cycleTime}us)...`);

      // Example: Find offsets for a specific variable if mapping exists
      // const mapping = master.getMappings().get("MyVariable");

      // Cycle time tracking
      let cycleCount = 0;
      let totalCycleTime = 0;
      let totalIntervalTime = 0;
      let running = true;

      // Precise timing loop using busy-wait for better accuracy
      const runCycleLoop = async () => {
        let nextCycleTime = performance.now() + cycleTimeMs;
        let previousCycleStart: number | null = null;

        while (running) {
          try {
            const cycleStart = performance.now();

            // Calculate actual interval time (time between cycle starts)
            if (previousCycleStart !== null) {
              const actualIntervalTime = cycleStart - previousCycleStart;
              totalIntervalTime += actualIntervalTime;
            }
            previousCycleStart = cycleStart;

            // Write outputs directly to shared buffer
            // pdiBuffer[offset] = value;

            // Single FFI call per cycle
            const wkc = await master.runCycle();
            const cycleEnd = performance.now();
            const executionTimeMs = cycleEnd - cycleStart;

            // Update average cycle time
            cycleCount++;
            totalCycleTime += executionTimeMs;
            const avgCycleTime = totalCycleTime / cycleCount;
            const avgIntervalTime = cycleCount > 1 ? totalIntervalTime / (cycleCount - 1) : 0;

            // Read inputs from shared buffer
            // const val = pdiBuffer[inputOffset];

            // Optional: Print WKC and average cycle time every second roughly
            if (Math.random() < 0.01) {
              console.log(
                `Cycle WKC: ${wkc}, Master cycleTime: ${cycleTime}us, Avg actual interval: ${
                  avgIntervalTime.toFixed(3)
                }ms, Avg actual cycle time: ${avgCycleTime.toFixed(3)}ms`,
              );
            }

            // Calculate next cycle time and busy-wait until then
            nextCycleTime = await waitUntilNextCycle(nextCycleTime, cycleTimeMs);
          } catch (e) {
            console.error("Cycle error:", e);
            running = false;
            master.close();
            Deno.exit(1);
          }
        }
      };

      // Start the cycle loop
      runCycleLoop();

      // Handle Ctrl+C to exit gracefully
      Deno.addSignalListener("SIGINT", () => {
        console.log("\nStopping...");
        running = false;
        master.requestState(SlaveState.INIT).then(() => {
          master.close();
          Deno.exit(0);
        });
      });

      // Stop after 30 seconds
      setTimeout(async () => {
        console.log("Stopping after 30 seconds...");
        running = false;
        await master.requestState(SlaveState.INIT);
        master.close();
        Deno.exit(0);
      }, 30000);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Topology mismatch")) {
          console.error(
            "\n❌ Topology Verification Failed",
          );
          console.error(
            "The physical EtherCAT network does not match the ENI configuration.",
          );
          console.error(
            "Please ensure that:\n" +
              "  • The network topology matches the ENI file\n" +
              "  • All slaves are connected and powered\n" +
              "  • The correct interface is selected\n" +
              "  • The ENI file corresponds to the current network setup",
          );
        } else {
          console.error("Runtime error:", error.message);
        }
      } else {
        console.error("Runtime error:", error);
      }
      master.close();
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error("Setup error:", error.message);
    } else {
      console.error("Setup error:", error);
    }
  }
}

/**
 * Waits until the next cycle time using precise timing.
 * For short waits (<1ms), uses busy-wait for precision.
 * For longer waits, uses setTimeout with busy-wait fine-tuning.
 * Returns the updated next cycle time.
 */
async function waitUntilNextCycle(
  nextCycleTime: number,
  cycleTimeMs: number,
): Promise<number> {
  nextCycleTime += cycleTimeMs;
  const now = performance.now();
  const waitTime = nextCycleTime - now;

  if (waitTime > 0) {
    // For short waits, use busy-wait for precision
    // For longer waits, yield to event loop
    if (waitTime < 1) {
      // Busy-wait for sub-millisecond precision
      while (performance.now() < nextCycleTime) {
        // Busy wait
      }
    } else {
      // For longer waits, use setTimeout but adjust for precision
      await new Promise((resolve) => {
        const start = performance.now();
        setTimeout(() => {
          // Fine-tune with busy-wait for the remaining time
          const elapsed = performance.now() - start;
          const remaining = waitTime - elapsed;
          if (remaining > 0) {
            const target = performance.now() + remaining;
            while (performance.now() < target) {
              // Busy wait
            }
          }
          resolve(undefined);
        }, Math.max(0, waitTime - 0.5)); // Leave 0.5ms for busy-wait
      });
    }
  } else {
    // We're behind schedule, adjust next cycle time
    nextCycleTime = performance.now() + cycleTimeMs;
  }

  return nextCycleTime;
}

if (import.meta.main) {
  await main();
}
