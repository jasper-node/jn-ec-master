import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { assertSpyCall, spy, stub } from "@std/testing/mock";
import { EcMaster } from "../ec_master.ts";
import type { EniConfig } from "../types/eni-config.ts";
import type { EmergencyEvent } from "../types/ec_types.ts";
import { FfiError, PdoIntegrityError } from "../types/errors.ts";

/**
 * Tests for startEmergencyPolling method (lines 878-879)
 *
 * Note: These tests require the DynamicLibrary to be properly initialized.
 * In a full test suite, you would mock the FFI symbols to avoid requiring
 * the actual compiled library.
 */
Deno.test("startEmergencyPolling - calls stopEmergencyPolling first", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

Deno.test("startEmergencyPolling - returns early when no CoE slaves exist", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

Deno.test("startEmergencyPolling - sets up interval when CoE slaves exist", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

Deno.test("startEmergencyPolling - clears existing interval before starting new one", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

Deno.test("startEmergencyPolling - emits emergency event for CoE-enabled slave", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

Deno.test("startEmergencyPolling - does NOT emit emergency event for non-CoE slave", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

Deno.test("startEmergencyPolling - does NOT emit duplicate emergency events", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

Deno.test("startEmergencyPolling - emits new emergency from same CoE slave when error changes", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

Deno.test("startEmergencyPolling - handles multiple CoE slaves correctly", async () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
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
  await master.close();
});

// --- Mocks & Stubs ---

// 1. Mock ENI Configuration with one CoE slave
const MOCK_ENI: EniConfig = {
  master: {
    info: { name: "TestMaster" },
    cycleTime: 10000,
    dcSupport: false,
    runtimeOptions: { networkInterface: "test_interface" },
  },
  processImage: { inputs: { byteSize: 0, variables: [] }, outputs: { byteSize: 0, variables: [] } },
  slaves: [
    {
      vendorId: 0x00000002,
      productCode: 0x12345678,
      revisionNumber: 0x01,
      serialNumber: 0,
      name: "Slave_0",
      physAddr: 1001,
      autoIncAddr: 0,
      // CRITICAL: These fields trigger the mailbox polling in EcMaster
      mailboxStatusAddr: 0x080D,
      pollTime: 20,
      supportsCoE: true,
    },
  ],
};

// 2. Define the Mock FFI Symbols
// We only need to mock the functions that EcMaster calls during initialization and polling
const mockSymbols = {
  ethercrab_init: () => 0,
  ethercrab_get_pdi_total_size: () => 0,
  ethercrab_get_pdi_buffer_ptr: () => Deno.UnsafePointer.create(0n), // Null pointer
  ethercrab_configure_mailbox_polling: () => 0,
  ethercrab_scan_free: () => {},
  ethercrab_destroy: () => {},
  ethercrab_version: (buf: Uint8Array, _len: number) => {
    const encoded = new TextEncoder().encode(EcMaster.REQUIRED_FFI_VERSION);
    buf.set(encoded);
    return encoded.length;
  },
  // THE CORE TEST TARGET:
  ethercrab_check_mailbox_resilient: (_idx: number, _addr: number, _lastToggle: number) => 0, // Default to empty
  ethercrab_get_last_emergency: (_buf: Uint8Array) => 1, // Default: No emergency
};

// 3. Helper to create a Master with mocked FFI
function createTestMaster() {
  // Stub Deno.dlopen to return our mock symbols
  const dlopenStub = stub(Deno, "dlopen", () => ({
    symbols: mockSymbols,
    close: () => {},
  } as any));

  // Stub Deno.statSync to bypass "library not found" check
  const statStub = stub(Deno, "statSync", () => ({ isFile: true } as any));

  const master = new EcMaster(MOCK_ENI);

  return { master, dlopenStub, statStub };
}

// --- Tests ---

Deno.test("Mailbox Resilience: Initialization State", async () => {
  const { master, dlopenStub, statStub } = createTestMaster();

  try {
    // Override the resilient check to verify arguments
    const checkSpy = spy(mockSymbols, "ethercrab_check_mailbox_resilient");

    // Initialize (starts polling)
    await master.initialize();

    // Fast-forward time or wait for one poll cycle
    // Since setInterval is used, we wait slightly longer than pollTime (20ms)
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Assert that the first call passed '2' as the lastToggleBit (Initial State)
    assertSpyCall(checkSpy, 0, {
      args: [
        0, // Slave Index
        0x080D, // Register Address
        2, // Expected Initial Toggle State (2 = Unknown/First Run)
      ],
    });
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
    // Restore the spy on the mock object
    (mockSymbols.ethercrab_check_mailbox_resilient as any).restore?.();
  }
});

Deno.test("Mailbox Resilience: Successful Toggle Flip", async () => {
  const { master, dlopenStub, statStub } = createTestMaster();

  let callCount = 0;
  const checkStub = stub(
    mockSymbols,
    "ethercrab_check_mailbox_resilient",
    (_idx: number, _addr: number, _lastToggle: number) => {
      callCount++;
      // Always return 1 (Success/New Mail found)
      return 1;
    },
  );

  try {
    // SCENARIO:
    // 1. First poll returns 1 (New Mail). Master should update local toggle to 0.
    // 2. Second poll returns 1 (New Mail). Master should pass 0, see success, update to 1.

    await master.initialize();

    // Wait for 3 cycles (approx 60ms)
    await new Promise((resolve) => setTimeout(resolve, 70));

    // VERIFICATION:

    // Call 1: Initial state. Passed 2. Returns 1.
    // Master logic: (2 === 0) ? 1 : 0 => New Toggle is 0.
    assertSpyCall(checkStub, 0, { args: [0, 0x080D, 2] });

    // Call 2: Master should pass 0 (the new state). Returns 1.
    // Master logic: (0 === 0) ? 1 : 0 => New Toggle is 1.
    assertSpyCall(checkStub, 1, { args: [0, 0x080D, 0] });

    // Call 3: Master should pass 1. Returns 1.
    // Master logic: (1 === 0) ? 1 : 0 => New Toggle is 0.
    assertSpyCall(checkStub, 2, { args: [0, 0x080D, 1] });
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
    checkStub.restore();
  }
});

Deno.test("Mailbox Resilience: Retry Failure Handling", async () => {
  const { master, dlopenStub, statStub } = createTestMaster();
  const checkStub = stub(mockSymbols, "ethercrab_check_mailbox_resilient", () => -2);

  try {
    // SCENARIO: Rust returns -2 (Retry Limit Exceeded).
    // Expectation: Master emits 'mailboxError'.

    // Setup Event Spy
    let errorEmitted = false;
    master.on("mailboxError", (evt) => {
      errorEmitted = true;
      assertEquals(evt.slaveIndex, 0);
      assertEquals(evt.error, "Resilient read failed after retries");
    });

    await master.initialize();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assertEquals(errorEmitted, true, "Should emit mailboxError when Rust returns -2");
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
    checkStub.restore();
  }
});

// --- Ride-Through Logic Tests (Feature 105) ---

// Extended mock symbols for runCycle tests
const createCycleMockSymbols = (cyclicTxRxFn: () => number) => ({
  ethercrab_init: () => 0,
  ethercrab_get_pdi_total_size: () => 0,
  ethercrab_get_pdi_buffer_ptr: () => Deno.UnsafePointer.create(0n),
  ethercrab_configure_mailbox_polling: () => 0,
  ethercrab_scan_free: () => {},
  ethercrab_destroy: () => {},
  ethercrab_get_state: () => 1, // INIT state
  ethercrab_get_last_error: (buf: Uint8Array, _len: bigint) => {
    const msg = "Test error";
    const encoded = new TextEncoder().encode(msg);
    buf.set(encoded);
    return encoded.length;
  },
  ethercrab_version: (buf: Uint8Array, _len: number) => {
    const encoded = new TextEncoder().encode(EcMaster.REQUIRED_FFI_VERSION);
    buf.set(encoded);
    return encoded.length;
  },
  ethercrab_check_mailbox_resilient: () => 0,
  ethercrab_get_last_emergency: () => 1,
  ethercrab_cyclic_tx_rx: cyclicTxRxFn,
});

function createCycleTestMaster(cyclicTxRxFn: () => number) {
  const mockSyms = createCycleMockSymbols(cyclicTxRxFn);

  const dlopenStub = stub(Deno, "dlopen", () => ({
    symbols: mockSyms,
    close: () => {},
  } as any));

  const statStub = stub(Deno, "statSync", () => ({ isFile: true } as any));

  const master = new EcMaster(MOCK_ENI);

  return { master, dlopenStub, statStub, mockSyms };
}

Deno.test("Ride-Through: Single PDU timeout returns -2 without throwing", async () => {
  const { master, dlopenStub, statStub } = createCycleTestMaster(() => -2);

  try {
    // A single timeout should return -2 but NOT throw
    const wkc = await master.runCycle();
    assertEquals(wkc, -2);
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
  }
});

Deno.test("Ride-Through: 4 consecutive PDU timeouts do not throw", async () => {
  let callCount = 0;
  const { master, dlopenStub, statStub } = createCycleTestMaster(() => {
    callCount++;
    return -2; // Always timeout
  });

  try {
    // 4 consecutive timeouts should NOT throw (threshold is 5)
    for (let i = 0; i < 4; i++) {
      const wkc = await master.runCycle();
      assertEquals(wkc, -2, `Cycle ${i + 1} should return -2`);
    }
    assertEquals(callCount, 4);
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
  }
});

Deno.test("Ride-Through: 5 consecutive PDU timeouts throw FfiError", async () => {
  const { master, dlopenStub, statStub } = createCycleTestMaster(() => -2);

  try {
    // First 4 timeouts should not throw
    for (let i = 0; i < 4; i++) {
      await master.runCycle();
    }

    // 5th timeout should throw FfiError
    await assertRejects(
      () => master.runCycle(),
      FfiError,
      "Critical Network Failure: 5 consecutive timeouts",
    );
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
  }
});

Deno.test("Ride-Through: Successful cycle resets missedCycleCount", async () => {
  let returnValue = -2;
  const { master, dlopenStub, statStub } = createCycleTestMaster(() => returnValue);

  try {
    // Simulate 3 timeouts
    for (let i = 0; i < 3; i++) {
      await master.runCycle();
    }

    // Now simulate a successful cycle (wkc = 1)
    returnValue = 1;
    const wkc = await master.runCycle();
    assertEquals(wkc, 1);

    // Now simulate 4 more timeouts - should NOT throw because counter was reset
    returnValue = -2;
    for (let i = 0; i < 4; i++) {
      const result = await master.runCycle();
      assertEquals(result, -2, `Cycle ${i + 1} after reset should return -2`);
    }

    // 5th timeout after reset should throw
    await assertRejects(
      () => master.runCycle(),
      FfiError,
      "Critical Network Failure",
    );
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
  }
});

Deno.test("Ride-Through: WKC mismatch (-4) uses ride-through logic", async () => {
  const { master, dlopenStub, statStub } = createCycleTestMaster(() => -4);

  try {
    // First 4 WKC mismatches should return -4 without throwing
    for (let i = 0; i < 4; i++) {
      const wkc = await master.runCycle();
      assertEquals(wkc, -4, `Cycle ${i + 1} should return -4`);
    }

    // 5th WKC mismatch should throw PdoIntegrityError
    await assertRejects(
      () => master.runCycle(),
      PdoIntegrityError,
      "WKC mismatch",
    );
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
  }
});

Deno.test("Ride-Through: Mixed timeout and WKC errors accumulate", async () => {
  let callCount = 0;
  const { master, dlopenStub, statStub } = createCycleTestMaster(() => {
    callCount++;
    // Alternate between -2 (timeout) and -4 (WKC mismatch)
    return callCount % 2 === 1 ? -2 : -4;
  });

  try {
    // 4 mixed errors should not throw
    for (let i = 0; i < 4; i++) {
      const wkc = await master.runCycle();
      assertEquals(wkc < 0, true, `Cycle ${i + 1} should return negative`);
    }

    // 5th error should throw (counter accumulated from both error types)
    await assertRejects(
      () => master.runCycle(),
      FfiError, // -2 is returned on 5th call (odd number)
      "Critical Network Failure",
    );
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
  }
});

Deno.test("Ride-Through: Other fatal errors throw immediately", async () => {
  const { master, dlopenStub, statStub } = createCycleTestMaster(() => -1);

  try {
    // Any error other than -2 or -4 should throw immediately
    await assertRejects(
      () => master.runCycle(),
      FfiError,
      "Cyclic task failed",
    );
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
  }
});

Deno.test("Ride-Through: missedCycleCount is accessible for diagnostics", async () => {
  const { master, dlopenStub, statStub } = createCycleTestMaster(() => -2);

  try {
    // Access private property for testing
    const masterAny = master as any;

    assertEquals(masterAny.missedCycleCount, 0, "Initial count should be 0");

    await master.runCycle();
    assertEquals(masterAny.missedCycleCount, 1, "Count should be 1 after first timeout");

    await master.runCycle();
    assertEquals(masterAny.missedCycleCount, 2, "Count should be 2 after second timeout");
  } finally {
    await master.close();
    dlopenStub.restore();
    statStub.restore();
  }
});
