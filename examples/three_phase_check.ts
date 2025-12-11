#!/usr/bin/env -S deno run --allow-ffi --allow-read --allow-net --unstable-ffi

import { EcMaster, SlaveState } from "../src/ec_master.ts";
import { PdoMapping } from "../src/types/ec_types.ts";

async function demonstrateThreePhaseWorkflow() {
  const ifname = Deno.args[0] || "eth0";

  console.log(`Discovering network on ${ifname}...`);
  const config = await EcMaster.discoverNetwork(ifname);
  console.log(`Discovered ${config.slaves.length} slaves.`);

  const master = new EcMaster(config);

  try {
    console.log("=== EtherCAT Three-Phase Workflow Demo (New Lib) ===\n");

    console.log("Step 1: Initialization & Topology Verification");
    console.log("---------------------------------------------------");

    // Initialize master (this sets up the group and discovers slaves)
    await master.initialize();
    console.log("✓ Master initialized");
    console.log("✓ Connected to interface " + config.interface);

    // Explicitly reset to INIT to clear any previous error states
    console.log("Requesting INIT state to clear faults...");
    try {
      await master.requestState(SlaveState.INIT);
      console.log("✓ Reached INIT");
    } catch (e) {
      console.warn("⚠ Failed to reach INIT (might already be in INIT):", e);
    }

    try {
      await master.verifyTopology();
      console.log("✓ Topology verified against configuration");
    } catch (e) {
      console.warn(
        "⚠ Topology verification warning (IDs might differ):",
        e instanceof Error ? e.message : e,
      );
    }

    config.slaves.forEach((slave, i) => {
      console.log(`  Slave ${i + 1}: ${slave.name}`);
      console.log(
        `    Vendor: 0x${(slave.vendorId || 0).toString(16).toUpperCase()}`,
      );
      console.log(
        `    Product: 0x${(slave.productCode || 0).toString(16).toUpperCase()}`,
      );
    });

    console.log("\nStep 2: Configuration (PDO Mappings)");
    console.log("-------------------------------------");

    const mappings = master.getMappings();

    console.log(`✓ Established ${mappings.size} PDO mappings`);
    mappings.forEach((mapping) => {
      console.log(
        `  ${mapping.variableName}: Offset ${mapping.pdiByteOffset}, ${mapping.dataType} ${
          mapping.bitOffset !== undefined ? `(Bit ${mapping.bitOffset})` : ""
        }`,
      );
    });

    // Find mappings for specific variables
    const findMapping = (variableName: string): PdoMapping | undefined => {
      return Array.from(mappings.values()).find((m) =>
        m.variableName === variableName || m.variableName.endsWith(`.${variableName}`)
      );
    };

    const el2008Output0 = findMapping("EL2008.Output_PDO_0");
    const el2008Output1 = findMapping("EL2008.Output_PDO_1");
    const el1809Input0 = findMapping("EL1809.Input_PDO_0");
    const el1809Input1 = findMapping("EL1809.Input_PDO_1");

    // Find first analog input from EL3062
    const el3062AnalogInput = Array.from(mappings.values()).find((m) =>
      m.variableName.startsWith("EL3062.") &&
      (m.dataType === "UINT16" || m.dataType === "INT16") &&
      m.isInput
    );

    console.log("\nStep 3: Cyclic Operation");
    console.log("-----------------------------------");

    console.log("Requesting PRE_OP state...");
    try {
      await master.requestState(SlaveState.PRE_OP);
      console.log("✓ Reached PRE_OP");
    } catch (e) {
      console.error("✗ Failed to reach PRE_OP:", e);
      throw e;
    }

    console.log("Requesting SAFE_OP state...");
    await new Promise((r) => setTimeout(r, 1000)); // Increased delay to 1s

    try {
      await master.requestState(SlaveState.SAFE_OP);
      console.log("✓ Reached SAFE_OP");
    } catch (e) {
      console.error("✗ Failed to reach SAFE_OP:", e);

      // Debug: Print AL Status Code for each slave to find the culprit
      console.log("Checking AL Status Codes for all slaves...");
      for (let i = 0; i < config.slaves.length; i++) {
        try {
          const status = await master.getLastAlStatusCode(i);
          console.log(
            `  Slave ${i + 1} (${config.slaves[i]?.name}) AL Status: 0x${status.toString(16)}`,
          );
        } catch (err) {
          console.warn(`  Failed to read status for Slave ${i + 1}:`, err);
        }
      }
      throw e;
    }

    console.log("Requesting OPERATIONAL state...");
    await new Promise((r) => setTimeout(r, 500));
    await master.requestState(SlaveState.OP);
    console.log("✓ System is OPERATIONAL");

    // Detect available card types by checking slave names
    const hasEL2008 = config.slaves.some((s) => s.name === "EL2008");
    const hasEL1809 = config.slaves.some((s) => s.name === "EL1809");
    const hasEL3062 = config.slaves.some((s) => s.name === "EL3062");

    console.log("Detected card types:");
    if (hasEL2008) console.log("  ✓ EL2008 (Digital Output) found");
    if (hasEL1809) console.log("  ✓ EL1809 (Digital Input) found");
    if (hasEL3062) console.log("  ✓ EL3062 (Analog Input) found");

    console.log("\nCyclic Operation Demo (30 seconds):");
    console.log("===================================");

    const startTime = Date.now();
    const cycleTimeMs = (config.master.cycleTime || 10000) / 1000; // 10ms
    let cycleCount = 0;

    const intervalId = setInterval(async () => {
      try {
        const elapsed = Date.now() - startTime;
        const elapsedSec = elapsed / 1000;

        // Write outputs BEFORE running the cycle using mapping.newValue
        if (hasEL2008 && el2008Output0 && el2008Output1) {
          const blinkPeriod = 1000; // 1 second blink period
          const blinkState = Math.floor(elapsed / blinkPeriod) % 2 === 0;
          el2008Output0.newValue = blinkState;
          el2008Output1.newValue = !blinkState;
        }

        // Run the cycle to send outputs and receive inputs
        const wkc = await master.runCycle();
        cycleCount++;

        // Read inputs AFTER running the cycle using mapping.currentValue
        let digitalInput1 = false;
        let digitalInput2 = false;
        let analogInput1 = 0;

        if (hasEL1809) {
          if (el1809Input0) {
            digitalInput1 = el1809Input0.currentValue as boolean;
          }
          if (el1809Input1) {
            digitalInput2 = el1809Input1.currentValue as boolean;
          }
        }

        if (hasEL3062 && el3062AnalogInput) {
          analogInput1 = el3062AnalogInput.currentValue as number;
        }

        // Log every 100 cycles
        if (cycleCount % 100 === 0) {
          const parts: string[] = [];
          if (hasEL1809) parts.push(`DI1:${digitalInput1 ? 1 : 0} DI2:${digitalInput2 ? 1 : 0}`);
          if (hasEL3062) parts.push(`AI1:${analogInput1}`);
          if (hasEL2008) {
            const blinkState = Math.floor(elapsedSec) % 2 === 0;
            parts.push(`DO1:${blinkState ? 1 : 0} DO2:${!blinkState ? 1 : 0}`);
          }
          console.log(
            `[${elapsedSec.toFixed(1)}s] Cycle ${cycleCount} (WKC: ${wkc}): ${parts.join(" ")}`,
          );
        }
      } catch (e) {
        if (cycleCount < 5) {
          console.error(`Cycle ${cycleCount} error:`, e);
        }
      }
    }, cycleTimeMs);

    const duration = 30000;
    setTimeout(async () => {
      clearInterval(intervalId);
      console.log(`\n✓ Cyclic operation completed (${cycleCount} cycles)`);

      try {
        await master.requestState(SlaveState.INIT);
        console.log("✓ State requested: INIT");
      } catch (e) {
        console.warn("Failed to restore INIT state:", e);
      }

      master.close();
      console.log("✓ EtherCAT master closed");
      Deno.exit(0);
    }, duration);

    Deno.addSignalListener("SIGINT", () => {
      console.log("\nStopping...");
      clearInterval(intervalId);
      master.requestState(SlaveState.INIT).catch(() => {}).finally(() => {
        master.close();
        Deno.exit(0);
      });
    });
  } catch (error) {
    try {
      const emergency = master.getLastEmergency();
      if (emergency) {
        console.error(
          `Last Emergency: Slave ${emergency.slaveId} Code 0x${
            emergency.errorCode.toString(16)
          } Reg 0x${emergency.errorReg.toString(16)}`,
        );
      }
    } catch (_) {
      // ignore
    }

    console.error("Runtime Error:", error);
    master.close();
    Deno.exit(1);
  }
}

if (import.meta.main) {
  demonstrateThreePhaseWorkflow();
}
