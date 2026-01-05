import { EcMaster, SlaveState } from "../src/ec_master.ts";
import { loadEniFromXml, parseEniJson } from "../src/utils/eni-loader.ts";
import { createCycleLoop } from "@controlx-io/cycle-loop";

async function main() {
  // Parse command line arguments
  const args = Deno.args;
  const fastFlag = args.includes("--fast");
  const nonFlagArgs = args.filter((arg) => !arg.startsWith("--"));
  const configFile = nonFlagArgs[0];
  const interfaceName = nonFlagArgs[1] || "eth0"; // Default to eth0 if not provided
  let lastWkc = 0;

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

    let master = new EcMaster(eniConfig);

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
      await intiMaster(master);

      // Feature 201: Cyclic operation with shared memory
      const cycleTimeMs = (eniConfig.master.cycleTime || 1000) / 1000;

      console.log(`Starting cyclic loop (cycle time: ${cycleTimeMs}ms)...`);

      let counter = 0;
      setInterval(() => {
        console.log(new Date().toISOString(), counter);
        counter++;
      }, 1000);

      // Example: Find offsets for a specific variable if mapping exists
      // const mapping = master.getMappings().get("MyVariable");

      // Create cycle loop
      const cycleController = createCycleLoop({
        cycleTimeMs: cycleTimeMs,
        cycleFn: async () => {
          // Write outputs directly to shared buffer
          // pdiBuffer[offset] = value;

          // Single FFI call per cycle
          const wkc = await master.runCycle();

          // Check for negative WKC which indicates errors or timeouts
          if (wkc < 0) {
            lastWkc = wkc;
            console.warn(new Date().toISOString(), `[Cycle] Warning: Comms lost (WKC: ${wkc})`);
            return wkc;
          }

          if (wkc > 0 && lastWkc < 0) {
            const stats = cycleController.getStats();
            console.log(
              new Date().toISOString(),
              `[Cycle] Warning: Comms regained (WKC: ${wkc}). Recovering network state...`,
              `Last execution time: ${stats.lastExecutionTimeMs.toFixed(3)}ms`,
            );
            // RECOVERY: Re-initialize to handle power-cycled slaves
            await intiMaster(master);
            cycleController.resetStats();
          }

          lastWkc = wkc;

          // Optional: Print WKC and average cycle time every second roughly
          const stats = cycleController.getStats();
          if (stats.cycleCount % 100 === 0 || (wkc > 0 && lastWkc < 0)) {
            console.log(
              `Cycle WKC: ${wkc}, Avg actual cycle time: ${stats.avgExecutionTimeMs.toFixed(3)}ms`,
            );
          }

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
      cycleController.start();

      // Handle Ctrl+C to exit gracefully
      Deno.addSignalListener("SIGINT", () => {
        console.log("\nStopping...");
        cycleController.stop();
        master.requestState(SlaveState.INIT).then(() => {
          master.close();
          Deno.exit(0);
        });
      });

      // Stop after 15 seconds
      setTimeout(async () => {
        console.log("Stopping after 15 seconds...");
        cycleController.stop();
        await master.requestState(SlaveState.INIT);
        master.close();
        Deno.exit(0);
      }, 15000);
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

if (import.meta.main) {
  await main();
}

async function intiMaster(master: EcMaster) {
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
}
