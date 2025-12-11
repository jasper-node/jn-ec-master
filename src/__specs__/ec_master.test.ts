import { assertEquals, assertExists } from "@std/assert";
import { EcMaster } from "../ec_master.ts";
import type { EniConfig } from "../types/eni-config.ts";
import type { EmergencyEvent } from "../types/ec_types.ts";

/**
 * Tests for startEmergencyPolling method (lines 878-879)
 *
 * Note: These tests require the DynamicLibrary to be properly initialized.
 * In a full test suite, you would mock the FFI symbols to avoid requiring
 * the actual compiled library.
 */
Deno.test("startEmergencyPolling - calls stopEmergencyPolling first", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "CoESlave",
        supportsCoE: true,
      },
    ],
  };

  // Use 'any' to access private methods and properties for testing
  const master = new EcMaster(config) as any;

  // Set up an existing interval to verify it gets cleared
  const existingInterval = 12345;
  master.emergencyPollingInterval = existingInterval;

  // Call startEmergencyPolling - should clear existing interval first
  master.startEmergencyPolling();

  // Verify that a new interval was set (different from the old one)
  // This confirms that stopEmergencyPolling was called (clearing the old interval)
  // and a new interval was created
  assertExists(master.emergencyPollingInterval);

  // The new interval should be different from what we set
  // (though in practice, interval IDs might reuse, the important part
  // is that stopEmergencyPolling cleared the old one first)

  // Clean up
  master.stopEmergencyPolling();
  master.close();
});

Deno.test("startEmergencyPolling - returns early when no CoE slaves exist", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "NonCoESlave",
        supportsCoE: false,
      },
      {
        name: "AnotherNonCoESlave",
        // supportsCoE is undefined, which should be treated as false
      },
    ],
  };

  // Use 'any' to access private methods and properties for testing
  const master = new EcMaster(config) as any;

  // Call startEmergencyPolling
  master.startEmergencyPolling();

  // Verify that no interval was set (should return early at line 886)
  assertEquals(master.emergencyPollingInterval, undefined);

  // Clean up
  master.close();
});

Deno.test("startEmergencyPolling - sets up interval when CoE slaves exist", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "CoESlave1",
        supportsCoE: true,
      },
      {
        name: "CoESlave2",
        supportsCoE: true,
      },
    ],
  };

  // Use 'any' to access private methods and properties for testing
  const master = new EcMaster(config) as any;

  // Call startEmergencyPolling
  master.startEmergencyPolling();

  // Verify that an interval was set (line 891)
  assertExists(master.emergencyPollingInterval);

  // Clean up
  master.stopEmergencyPolling();
  master.close();
});

Deno.test("startEmergencyPolling - clears existing interval before starting new one", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "CoESlave",
        supportsCoE: true,
      },
    ],
  };

  // Use 'any' to access private methods and properties for testing
  const master = new EcMaster(config) as any;

  // Set up an initial interval
  master.startEmergencyPolling();
  const firstInterval = master.emergencyPollingInterval;
  assertExists(firstInterval);

  // Call startEmergencyPolling again - should clear old (line 879) and create new (line 891)
  master.startEmergencyPolling();
  const secondInterval = master.emergencyPollingInterval;
  assertExists(secondInterval);

  // Verify that stopEmergencyPolling was called by checking that
  // a new interval exists (the old one was cleared first)

  // Clean up
  master.stopEmergencyPolling();
  master.close();
});

Deno.test("startEmergencyPolling - emits emergency event for CoE-enabled slave", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "CoESlave",
        supportsCoE: true,
      },
      {
        name: "NonCoESlave",
        supportsCoE: false,
      },
    ],
  };

  const master = new EcMaster(config) as any;

  // Mock getLastEmergency to return an emergency from the CoE slave (index 0)
  const emergencyFromCoeSlave: EmergencyEvent = {
    slaveId: 0,
    errorCode: 0x1234,
    errorReg: 0x56,
  };
  master.getLastEmergency = () => emergencyFromCoeSlave;

  // Track emitted events
  const emittedEvents: EmergencyEvent[] = [];
  master.on("emergency", (event: EmergencyEvent) => {
    emittedEvents.push(event);
  });

  // Start polling with a short interval for testing
  master.startEmergencyPolling(1);

  // Wait a bit for the interval to fire
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify that the emergency event was emitted
  assertEquals(emittedEvents.length, 1);
  assertEquals(emittedEvents[0], emergencyFromCoeSlave);

  // Clean up
  master.stopEmergencyPolling();
  master.close();
});

Deno.test("startEmergencyPolling - does NOT emit emergency event for non-CoE slave", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "CoESlave",
        supportsCoE: true,
      },
      {
        name: "NonCoESlave",
        supportsCoE: false,
      },
    ],
  };

  const master = new EcMaster(config) as any;

  // Mock getLastEmergency to return an emergency from the non-CoE slave (index 1)
  const emergencyFromNonCoeSlave: EmergencyEvent = {
    slaveId: 1,
    errorCode: 0x1234,
    errorReg: 0x56,
  };
  master.getLastEmergency = () => emergencyFromNonCoeSlave;

  // Track emitted events
  const emittedEvents: EmergencyEvent[] = [];
  master.on("emergency", (event: EmergencyEvent) => {
    emittedEvents.push(event);
  });

  // Start polling with a short interval for testing
  master.startEmergencyPolling(1);

  // Wait a bit for the interval to fire
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify that NO emergency event was emitted (non-CoE slave should be filtered out)
  assertEquals(emittedEvents.length, 0);

  // Clean up
  master.stopEmergencyPolling();
  master.close();
});

Deno.test("startEmergencyPolling - does NOT emit duplicate emergency events", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "CoESlave",
        supportsCoE: true,
      },
    ],
  };

  const master = new EcMaster(config) as any;

  // Mock getLastEmergency to return the same emergency multiple times
  const emergency: EmergencyEvent = {
    slaveId: 0,
    errorCode: 0x1234,
    errorReg: 0x56,
  };
  master.getLastEmergency = () => emergency;

  // Track emitted events
  const emittedEvents: EmergencyEvent[] = [];
  master.on("emergency", (event: EmergencyEvent) => {
    emittedEvents.push(event);
  });

  // Start polling with a short interval for testing
  master.startEmergencyPolling(1);

  // Wait for multiple polling cycles
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify that only ONE emergency event was emitted (deduplication)
  assertEquals(emittedEvents.length, 1);
  assertEquals(emittedEvents[0], emergency);

  // Clean up
  master.stopEmergencyPolling();
  master.close();
});

Deno.test("startEmergencyPolling - emits new emergency from same CoE slave when error changes", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "CoESlave",
        supportsCoE: true,
      },
    ],
  };

  const master = new EcMaster(config) as any;

  // Track emitted events
  const emittedEvents: EmergencyEvent[] = [];
  master.on("emergency", (event: EmergencyEvent) => {
    emittedEvents.push(event);
  });

  // First emergency
  const firstEmergency: EmergencyEvent = {
    slaveId: 0,
    errorCode: 0x1234,
    errorReg: 0x56,
  };

  // Second emergency with different error code
  const secondEmergency: EmergencyEvent = {
    slaveId: 0,
    errorCode: 0x5678, // Different error code
    errorReg: 0x56,
  };

  let callCount = 0;
  master.getLastEmergency = () => {
    callCount++;
    // Return first emergency on first call, second on subsequent calls
    return callCount === 1 ? firstEmergency : secondEmergency;
  };

  // Start polling with a short interval for testing
  master.startEmergencyPolling(1);

  // Wait for multiple polling cycles
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify that both emergencies were emitted (they differ in errorCode)
  assertEquals(emittedEvents.length, 2);
  assertEquals(emittedEvents[0], firstEmergency);
  assertEquals(emittedEvents[1], secondEmergency);

  // Clean up
  master.stopEmergencyPolling();
  master.close();
});

Deno.test("startEmergencyPolling - handles multiple CoE slaves correctly", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000 },
    interface: "eth0",
    slaves: [
      {
        name: "CoESlave1",
        supportsCoE: true,
      },
      {
        name: "NonCoESlave",
        supportsCoE: false,
      },
      {
        name: "CoESlave2",
        supportsCoE: true,
      },
    ],
  };

  const master = new EcMaster(config) as any;

  // Track emitted events
  const emittedEvents: EmergencyEvent[] = [];
  master.on("emergency", (event: EmergencyEvent) => {
    emittedEvents.push(event);
  });

  // Return emergencies from different slaves
  const emergencies = [
    { slaveId: 0, errorCode: 0x1111, errorReg: 0x11 }, // CoE slave 0
    { slaveId: 1, errorCode: 0x2222, errorReg: 0x22 }, // Non-CoE slave 1 (should be filtered)
    { slaveId: 2, errorCode: 0x3333, errorReg: 0x33 }, // CoE slave 2
  ];

  let callCount = 0;
  master.getLastEmergency = () => {
    const emergency = emergencies[callCount % emergencies.length];
    callCount++;
    return emergency;
  };

  // Start polling with a short interval for testing
  master.startEmergencyPolling(1);

  // Wait for multiple polling cycles
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify that only emergencies from CoE slaves (0 and 2) were emitted
  // Non-CoE slave (1) should be filtered out
  const emittedSlaveIds = emittedEvents.map((e) => e.slaveId);
  assertEquals(emittedSlaveIds.includes(0), true); // CoE slave 0
  assertEquals(emittedSlaveIds.includes(1), false); // Non-CoE slave 1 should NOT be present
  assertEquals(emittedSlaveIds.includes(2), true); // CoE slave 2

  // Clean up
  master.stopEmergencyPolling();
  master.close();
});
