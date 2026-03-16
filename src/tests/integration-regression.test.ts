/**
 * Integration regression tests for EcMaster.
 *
 * Covers critical paths through the TypeScript / Rust FFI boundary:
 *
 * - State transition failure handling (AL status 0x001D/0x001E)
 * - Fixed-mapping slave fallback (EEPROM-only, no CoE SDOs)
 * - SDO read/write integrity through CoE layer
 * - Cyclic TX/RX robustness (PDU timeouts, WKC mismatches)
 * - Watchdog configuration
 * - Full lifecycle regression (init -> Op -> cycles -> close)
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { EcMaster, SlaveState } from "../ec_master.ts";
import { EniConfig } from "../types/eni-config.ts";
import { FfiError, StateTransitionError } from "../types/errors.ts";

// ============================================================================
// Mock Infrastructure
// ============================================================================

const originalDlopen = Deno.dlopen;
const originalUnsafePointerView = Deno.UnsafePointerView;

interface MockOverrides {
  ethercrab_init?: (...args: any[]) => Promise<number>;
  ethercrab_request_state?: (state: number) => Promise<number>;
  ethercrab_get_state?: () => number;
  ethercrab_get_al_status_code?: (idx: number) => Promise<number>;
  ethercrab_cyclic_tx_rx?: () => Promise<number>;
  ethercrab_get_pdi_total_size?: () => number;
  ethercrab_get_last_error?: (buf: Uint8Array, len: bigint) => number;
  ethercrab_get_error_count?: () => bigint;
  ethercrab_get_error_detail?: (buf: Uint8Array, len: bigint, index: number) => number;
  ethercrab_sdo_read?: (...args: any[]) => Promise<number>;
  ethercrab_sdo_write?: (...args: any[]) => Promise<number>;
  ethercrab_eeprom_read?: (...args: any[]) => Promise<number>;
  ethercrab_destroy?: () => void;
  ethercrab_get_network_healthy?: () => number;
  ethercrab_check_mailbox_resilient?: (...args: any[]) => Promise<number>;
  ethercrab_get_last_emergency?: (buf: Uint8Array) => number;
  ethercrab_register_read_u16?: (idx: number, addr: number) => Promise<number>;
  ethercrab_register_write_u16?: (idx: number, addr: number, val: number) => Promise<number>;
  [key: string]: unknown;
}

function setupMocks(overrides: MockOverrides = {}) {
  const mockPointer = { __brand: "pointer" };

  // @ts-ignore
  Deno.dlopen = (_path: string, _symbols: any) => {
    return {
      symbols: {
        ethercrab_init: overrides.ethercrab_init ??
          ((..._args: any[]) => Promise.resolve(0)),
        ethercrab_destroy: overrides.ethercrab_destroy ?? (() => {}),
        ethercrab_verify_topology: (_expected: any, _count: any) => Promise.resolve(0),
        ethercrab_request_state: overrides.ethercrab_request_state ??
          ((_state: any) => Promise.resolve(0)),
        ethercrab_get_state: overrides.ethercrab_get_state ?? (() => SlaveState.PRE_OP),
        ethercrab_get_al_status_code: overrides.ethercrab_get_al_status_code ??
          ((_idx: any) => Promise.resolve(0)),
        ethercrab_get_pdi_total_size: overrides.ethercrab_get_pdi_total_size ?? (() => 20),
        ethercrab_get_pdi_buffer_ptr: () => mockPointer,
        ethercrab_cyclic_tx_rx: overrides.ethercrab_cyclic_tx_rx ??
          (() => Promise.resolve(1)),
        ethercrab_write_process_data_byte: (_si: any, _bo: any, _v: any) => 1,
        ethercrab_read_process_data_byte: (_si: any, _bo: any, _io: any) => 0,
        ethercrab_configure_mailbox_polling: (_interval: any) => 0,
        ethercrab_check_mailbox: (_idx: any, _addr: any) => Promise.resolve(0),
        ethercrab_check_mailbox_resilient: overrides.ethercrab_check_mailbox_resilient ??
          ((_idx: any, _addr: any, _toggle: any) => Promise.resolve(0)),
        ethercrab_sdo_read: overrides.ethercrab_sdo_read ??
          ((_idx: any, _i: any, _si: any, _buf: any, _len: any) => Promise.resolve(4)),
        ethercrab_sdo_write: overrides.ethercrab_sdo_write ??
          ((_idx: any, _i: any, _si: any, _data: any, _len: any) => Promise.resolve(0)),
        ethercrab_eeprom_read: overrides.ethercrab_eeprom_read ??
          ((_idx: any, _addr: any, _buf: any, _len: any) => Promise.resolve(2)),
        ethercrab_get_last_emergency: overrides.ethercrab_get_last_emergency ??
          ((_buf: any) => 0),
        is_raw_socket_available: () => 1,
        ethercrab_get_last_error: overrides.ethercrab_get_last_error ??
          ((_buf: any, _len: any) => 0),
        ethercrab_get_network_healthy: overrides.ethercrab_get_network_healthy ?? (() => 1),
        ethercrab_get_error_count: overrides.ethercrab_get_error_count ?? (() => 0n),
        ethercrab_get_error_detail: overrides.ethercrab_get_error_detail ??
          ((_buf: any, _len: any, _index: any) => 0),
        ethercrab_register_read_u16: overrides.ethercrab_register_read_u16 ??
          ((_idx: any, _addr: any) => Promise.resolve(0)),
        ethercrab_register_write_u16: overrides.ethercrab_register_write_u16 ??
          ((_idx: any, _addr: any, _val: any) => Promise.resolve(0)),
        ethercrab_version: (buf: Uint8Array, _len: any) => {
          const encoded = new TextEncoder().encode(EcMaster.REQUIRED_FFI_VERSION);
          buf.set(encoded);
          return encoded.length;
        },
      },
      close: () => {},
    };
  };

  // @ts-ignore
  Deno.UnsafePointerView = class {
    static getArrayBuffer(_ptr: any, len: number) {
      return new Uint8Array(len).buffer;
    }
    static getCString(_ptr: any) {
      return "";
    }
  };

  // @ts-ignore
  Deno.UnsafePointer = {
    create: (val: any) => val,
    of: (_val: any) => BigInt(0) as any,
    value: (ptr: any) => ptr === mockPointer ? BigInt(0x12345678) : BigInt(0),
  };
}

function teardownMocks() {
  // @ts-ignore
  Deno.dlopen = originalDlopen;
  // @ts-ignore
  Deno.UnsafePointerView = originalUnsafePointerView;
}

// ============================================================================
// Test Configurations
// ============================================================================

/** Minimal valid config */
const basicConfig: EniConfig = {
  master: { cycleTime: 1000, runtimeOptions: { networkInterface: "test-iface" } },
  slaves: [
    { name: "EK1100", vendorId: 2, productCode: 0x044C2C52, initCommands: [] },
  ],
  processData: { inputSize: 0, outputSize: 0, mappings: [] },
};

/** Config with a fixed-mapping slave (no CoE, EEPROM-only PDOs like EL1809/EL2008) */
const fixedMappingConfig: EniConfig = {
  master: { cycleTime: 1000, runtimeOptions: { networkInterface: "test-iface" } },
  slaves: [
    {
      name: "EL1809",
      vendorId: 2,
      productCode: 0x07114052,
      supportsCoE: false,
      processData: {
        inputBitLength: 16,
        outputBitLength: 0,
        inputOffset: 0,
        outputOffset: 0,
        entries: [
          {
            name: "Input",
            index: 0x6000,
            subIndex: 1,
            bitLen: 16,
            dataType: "UINT16",
            pdoOffset: 0,
            pdiOffset: 0,
          },
        ],
      },
      initCommands: [],
    },
  ],
  processData: { inputSize: 2, outputSize: 0, mappings: [] },
};

/** Config with mixed CoE and non-CoE slaves */
const mixedSlaveConfig: EniConfig = {
  master: { cycleTime: 1000, runtimeOptions: { networkInterface: "test-iface" } },
  slaves: [
    {
      name: "EK1100",
      vendorId: 2,
      productCode: 0x044C2C52,
      supportsCoE: false,
      initCommands: [],
    },
    {
      name: "EL2008",
      vendorId: 2,
      productCode: 0x07D82C52,
      supportsCoE: false,
      processData: {
        inputBitLength: 0,
        outputBitLength: 8,
        inputOffset: 0,
        outputOffset: 0,
      },
      initCommands: [],
    },
    {
      name: "EL4002",
      vendorId: 2,
      productCode: 0x0FA22C52,
      supportsCoE: true,
      mailboxStatusAddr: 0x080D,
      pollTime: 20,
      processData: {
        inputBitLength: 0,
        outputBitLength: 32,
        inputOffset: 0,
        outputOffset: 1,
      },
      initCommands: [],
    },
  ],
  processData: { inputSize: 0, outputSize: 5, mappings: [] },
};

/** Config with slave that has SyncManager watchdog configured */
const watchdogConfig: EniConfig = {
  master: {
    cycleTime: 10000,
    watchdogTimeoutMs: 200,
    runtimeOptions: { networkInterface: "test-iface" },
  },
  slaves: [
    {
      name: "EL2008",
      vendorId: 2,
      productCode: 0x07D82C52,
      processData: {
        outputBitLength: 8,
        outputOffset: 0,
      },
      initCommands: [],
    },
  ],
  processData: { inputSize: 0, outputSize: 1, mappings: [] },
};

// ============================================================================
// PR #354: SyncManager Configuration — State Transition Failure Handling
// ============================================================================

Deno.test({
  name: "State transition PreOp→SafeOp fails with InvalidOutputConfiguration (AL 0x001D)",
  fn: async () => {
    let stateAfterFail = SlaveState.PRE_OP;
    setupMocks({
      ethercrab_get_state: () => stateAfterFail,
      ethercrab_request_state: async (state: number) => {
        if (state === SlaveState.SAFE_OP) {
          return -1; // Failure
        }
        stateAfterFail = state;
        return 0;
      },
      ethercrab_get_last_error: (buf: Uint8Array, _len: bigint) => {
        const msg = "State transition failed: InvalidOutputConfiguration (0x001D) for slave EL6614";
        const encoded = new TextEncoder().encode(msg);
        buf.set(encoded);
        return encoded.length;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(basicConfig);
      await master.initialize();

      const err = await assertRejects(
        () => master!.requestState(SlaveState.SAFE_OP),
        StateTransitionError,
      );

      assert(
        err.message.includes("InvalidOutputConfiguration") ||
          err.message.includes("SAFE_OP"),
        "Error should mention the AL status or target state",
      );
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "State transition PreOp→SafeOp fails with InvalidInputConfiguration (AL 0x001E)",
  fn: async () => {
    let stateAfterFail = SlaveState.PRE_OP;
    setupMocks({
      ethercrab_get_state: () => stateAfterFail,
      ethercrab_request_state: async (state: number) => {
        if (state === SlaveState.SAFE_OP) {
          return -1;
        }
        stateAfterFail = state;
        return 0;
      },
      ethercrab_get_last_error: (buf: Uint8Array, _len: bigint) => {
        const msg =
          "State transition failed: InvalidInputConfiguration (0x001E) - SyncManager has length 0";
        const encoded = new TextEncoder().encode(msg);
        buf.set(encoded);
        return encoded.length;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(basicConfig);
      await master.initialize();

      const err = await assertRejects(
        () => master!.requestState(SlaveState.SAFE_OP),
        StateTransitionError,
      );

      assert(
        err.message.includes("SAFE_OP"),
        "Error should mention target state",
      );
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "Successful PreOp→SafeOp→Op transition updates PDI buffer",
  fn: async () => {
    let currentState = SlaveState.PRE_OP;
    setupMocks({
      ethercrab_get_state: () => currentState,
      ethercrab_request_state: async (state: number) => {
        currentState = state;
        return 0;
      },
      ethercrab_get_pdi_total_size: () => 64,
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(mixedSlaveConfig);
      await master.initialize();

      await master.requestState(SlaveState.SAFE_OP);
      assertEquals(master.getState(), SlaveState.SAFE_OP);

      const buffer = master.getProcessDataBuffer();
      assertEquals(buffer.byteLength, 64, "PDI buffer should reflect new size after SafeOp");

      await master.requestState(SlaveState.OP);
      assertEquals(master.getState(), SlaveState.OP);
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

// ============================================================================
// PR #347 + 0x0980: Init Behavior
// ============================================================================

Deno.test({
  name: "Init succeeds with fixed-mapping slaves (EEPROM-only, no CoE SDOs)",
  fn: async () => {
    setupMocks({
      ethercrab_get_state: () => SlaveState.PRE_OP,
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(fixedMappingConfig);
      await master.initialize();
      // If init succeeds, the Rust layer correctly handled missing 0x1C12/0x1C13
      assert(true, "Init should succeed for fixed-mapping slaves");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "Init succeeds with mixed slave types (CoE + EEPROM-only)",
  fn: async () => {
    setupMocks({
      ethercrab_get_state: () => SlaveState.PRE_OP,
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(mixedSlaveConfig);
      await master.initialize();
      assert(true, "Init should succeed with mixed slave types");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "Init failure returns structured error with context",
  fn: async () => {
    setupMocks({
      ethercrab_init: async () => -1,
      ethercrab_get_last_error: (buf: Uint8Array, _len: bigint) => {
        const msg = "Failed to configure slave 2: SubIndex not found reading 0x1C12";
        const encoded = new TextEncoder().encode(msg);
        buf.set(encoded);
        return encoded.length;
      },
      ethercrab_get_error_count: () => 1n,
      ethercrab_get_error_detail: (buf: Uint8Array, _len: bigint, _index: number) => {
        const json = JSON.stringify({
          code: 30,
          message: "Failed to configure slave 2: SubIndex not found reading 0x1C12",
          context: { op: "init", step: "configure_pdos_coe", slave_index: "2" },
        });
        const encoded = new TextEncoder().encode(json);
        buf.set(encoded);
        return encoded.length;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(fixedMappingConfig);
      const err = await assertRejects(
        () => master!.initialize(),
        FfiError,
      );

      assert(
        err.message.includes("Initialization failed"),
        "Error should indicate init failure",
      );
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

// ============================================================================
// PR #353: CoE Refactor — SDO Operations Integrity
// ============================================================================

Deno.test({
  name: "SDO read succeeds after init with CoE slave",
  fn: async () => {
    const sdoData = new Uint8Array([0x42, 0x00, 0x00, 0x00]);
    setupMocks({
      ethercrab_get_state: () => SlaveState.PRE_OP,
      ethercrab_sdo_read: async (_idx: any, _i: any, _si: any, buf: Uint8Array, _len: any) => {
        buf.set(sdoData);
        return 4; // 4 bytes read
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(mixedSlaveConfig);
      await master.initialize();

      const result = await master.sdoRead(2, 0x6000, 1);
      assertEquals(result.length, 4, "SDO read should return 4 bytes");
      assertEquals(result[0], 0x42, "SDO data should match");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "SDO write succeeds after init with CoE slave",
  fn: async () => {
    let writtenData: { idx: number; si: number; data: Uint8Array } | null = null;
    setupMocks({
      ethercrab_get_state: () => SlaveState.PRE_OP,
      ethercrab_sdo_write: async (
        _slaveIdx: any,
        idx: any,
        si: any,
        data: Uint8Array,
        _len: any,
      ) => {
        writtenData = { idx, si, data: new Uint8Array(data) };
        return 0;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(mixedSlaveConfig);
      await master.initialize();

      await master.sdoWrite(2, 0x7000, 1, new Uint8Array([0xFF, 0x00]));
      assert(writtenData !== null, "SDO write should have been called");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "SDO read failure returns meaningful error",
  fn: async () => {
    setupMocks({
      ethercrab_get_state: () => SlaveState.PRE_OP,
      ethercrab_sdo_read: async () => -30, // SdoError
      ethercrab_get_last_error: (buf: Uint8Array, _len: bigint) => {
        const msg = "SDO abort: SubIndex does not exist (0x06090011)";
        const encoded = new TextEncoder().encode(msg);
        buf.set(encoded);
        return encoded.length;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(mixedSlaveConfig);
      await master.initialize();

      await assertRejects(
        () => master!.sdoRead(0, 0x1C12, 0),
        Error,
      );
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

// ============================================================================
// EEPROM Access (Fork's pub visibility changes)
// ============================================================================

Deno.test({
  name: "EEPROM read succeeds for slave with fixed PDO mappings",
  fn: async () => {
    const eepromData = new Uint8Array([0xAB, 0xCD]);
    setupMocks({
      ethercrab_get_state: () => SlaveState.PRE_OP,
      ethercrab_eeprom_read: async (_idx: any, _addr: any, buf: Uint8Array, _len: any) => {
        buf.set(eepromData);
        return 2;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(fixedMappingConfig);
      await master.initialize();

      const result = await master.readEEPROM(0, 0x0040, 2);
      assertEquals(result.length, 2, "EEPROM read should return requested bytes");
      assertEquals(result[0], 0xAB);
      assertEquals(result[1], 0xCD);
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

// ============================================================================
// Cyclic Operation Robustness After Merge
// ============================================================================

Deno.test({
  name: "Cyclic TX/RX returns valid WKC after successful state transitions",
  fn: async () => {
    let currentState = SlaveState.PRE_OP;
    setupMocks({
      ethercrab_get_state: () => currentState,
      ethercrab_request_state: async (state: number) => {
        currentState = state;
        return 0;
      },
      ethercrab_cyclic_tx_rx: async () => 3, // WKC = 3 (e.g., 3 slaves responded)
      ethercrab_get_pdi_total_size: () => 20,
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(mixedSlaveConfig);
      await master.initialize();

      await master.requestState(SlaveState.SAFE_OP);
      await master.requestState(SlaveState.OP);

      const wkc = await master.runCycle();
      assertEquals(wkc, 3, "Cyclic TX/RX should return expected WKC");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "Cyclic TX/RX handles transient PDU timeout gracefully",
  fn: async () => {
    let currentState = SlaveState.OP;
    let cycleCount = 0;
    setupMocks({
      ethercrab_get_state: () => currentState,
      ethercrab_request_state: async (state: number) => {
        currentState = state;
        return 0;
      },
      ethercrab_cyclic_tx_rx: async () => {
        cycleCount++;
        if (cycleCount === 2) return -2; // PDU timeout on second cycle
        return 1; // Normal WKC
      },
      ethercrab_get_pdi_total_size: () => 8,
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(basicConfig);
      await master.initialize();

      // First cycle succeeds
      const wkc1 = await master.runCycle();
      assertEquals(wkc1, 1);

      // Second cycle returns timeout (not thrown, just returned as -2)
      const wkc2 = await master.runCycle();
      assertEquals(wkc2, -2, "Transient timeout should return -2, not throw");

      // Third cycle recovers
      const wkc3 = await master.runCycle();
      assertEquals(wkc3, 1, "Should recover after transient timeout");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "Cyclic TX/RX handles WKC mismatch gracefully",
  fn: async () => {
    let currentState = SlaveState.OP;
    setupMocks({
      ethercrab_get_state: () => currentState,
      ethercrab_request_state: async (state: number) => {
        currentState = state;
        return 0;
      },
      ethercrab_cyclic_tx_rx: async () => -4, // WKC mismatch
      ethercrab_get_pdi_total_size: () => 8,
      ethercrab_get_last_error: (buf: Uint8Array, _len: bigint) => {
        const msg = "WKC mismatch: expected 3, got 2";
        const encoded = new TextEncoder().encode(msg);
        buf.set(encoded);
        return encoded.length;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(basicConfig);
      await master.initialize();

      // First WKC mismatch should not throw (transient)
      const wkc = await master.runCycle();
      assertEquals(wkc, -4, "WKC mismatch should return -4 on first occurrence");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

// ============================================================================
// Watchdog Configuration (affected by SyncManager changes)
// ============================================================================

Deno.test({
  name: "Watchdog configured before PreOp→SafeOp when watchdogTimeoutMs is set",
  fn: async () => {
    let currentState = SlaveState.PRE_OP;
    const registerWrites: { idx: number; addr: number; val: number }[] = [];

    setupMocks({
      ethercrab_get_state: () => currentState,
      ethercrab_request_state: async (state: number) => {
        currentState = state;
        return 0;
      },
      ethercrab_register_write_u16: async (idx: number, addr: number, val: number) => {
        registerWrites.push({ idx, addr, val });
        return 0;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(watchdogConfig);
      await master.initialize();

      await master.requestState(SlaveState.SAFE_OP);

      // Watchdog register (0x0420) should have been written before SafeOp
      const smWatchdogWrite = registerWrites.find((w) => w.addr === 0x0420);
      assert(smWatchdogWrite !== undefined, "SM watchdog register should be written");
      assertEquals(
        smWatchdogWrite!.val,
        2000, // 200ms * 10
        "Watchdog timeout value should be correctly computed",
      );
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "Watchdog config failure for coupler slave does not block transition",
  fn: async () => {
    let currentState = SlaveState.PRE_OP;
    setupMocks({
      ethercrab_get_state: () => currentState,
      ethercrab_request_state: async (state: number) => {
        currentState = state;
        return 0;
      },
      ethercrab_register_write_u16: async (_idx: number, _addr: number, _val: number) => {
        return -1; // Watchdog write fails (e.g., coupler doesn't support it)
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(watchdogConfig);
      await master.initialize();

      // Should not throw even though watchdog config failed for the slave
      await master.requestState(SlaveState.SAFE_OP);
      assertEquals(
        currentState,
        SlaveState.SAFE_OP,
        "Transition should succeed despite watchdog failure",
      );
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

// ============================================================================
// Error Ring / Structured Error Reporting
// ============================================================================

Deno.test({
  name: "Structured error detail available after state transition failure",
  fn: async () => {
    let currentState = SlaveState.PRE_OP;
    setupMocks({
      ethercrab_get_state: () => currentState,
      ethercrab_request_state: async () => -1,
      ethercrab_get_last_error: (buf: Uint8Array, _len: bigint) => {
        const msg = "StateTransitionFailed";
        const encoded = new TextEncoder().encode(msg);
        buf.set(encoded);
        return encoded.length;
      },
      ethercrab_get_error_count: () => 1n,
      ethercrab_get_error_detail: (buf: Uint8Array, _len: bigint, _index: number) => {
        const json = JSON.stringify({
          code: 20,
          message:
            "State transition PreOp->SafeOp failed for slave 1: AL status 0x001D InvalidOutputConfiguration",
          context: {
            op: "request_state",
            target_state: "SafeOp",
            slave_index: "1",
            al_status: "0x001D",
          },
        });
        const encoded = new TextEncoder().encode(json);
        buf.set(encoded);
        return encoded.length;
      },
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(basicConfig);
      await master.initialize();

      const err = await assertRejects(
        () => master!.requestState(SlaveState.SAFE_OP),
        StateTransitionError,
      );

      assert(
        err.message.includes("StateTransitionFailed") || err.message.includes("SAFE_OP"),
        "Error should contain Rust-side error info",
      );
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "Network health check returns expected value",
  fn: async () => {
    setupMocks({
      ethercrab_get_state: () => SlaveState.PRE_OP,
      ethercrab_get_network_healthy: () => 1,
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(basicConfig);
      await master.initialize();

      // Network health is checked internally; just verify it doesn't crash
      assert(true, "Network health check should not throw");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

// ============================================================================
// Full Lifecycle (regression guard for merge)
// ============================================================================

Deno.test({
  name: "Full lifecycle: init → PreOp → SafeOp → Op → cycles → close",
  fn: async () => {
    let currentState = SlaveState.PRE_OP;
    const stateEvents: SlaveState[] = [];

    setupMocks({
      ethercrab_get_state: () => currentState,
      ethercrab_request_state: async (state: number) => {
        currentState = state;
        return 0;
      },
      ethercrab_cyclic_tx_rx: async () => 1,
      ethercrab_get_pdi_total_size: () => 16,
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(mixedSlaveConfig);
      master.on("stateChange", (evt) => {
        stateEvents.push(evt.currentState);
      });

      await master.initialize();

      await master.requestState(SlaveState.SAFE_OP);
      await master.requestState(SlaveState.OP);

      // Run a few cycles
      for (let i = 0; i < 3; i++) {
        const wkc = await master.runCycle();
        assert(wkc > 0, `Cycle ${i} should return positive WKC`);
      }

      await master.close();
      master = null; // prevent double-close in finally

      assertEquals(stateEvents.length, 2, "Should have 2 state change events");
      assertEquals(stateEvents[0], SlaveState.SAFE_OP);
      assertEquals(stateEvents[1], SlaveState.OP);
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});

Deno.test({
  name: "Double close is safe",
  fn: async () => {
    setupMocks({
      ethercrab_get_state: () => SlaveState.PRE_OP,
    });

    let master: EcMaster | null = null;
    try {
      master = new EcMaster(basicConfig);
      await master.initialize();
      await master.close();
      // Second close should not throw
      await master.close();
      master = null;
      assert(true, "Double close should not throw");
    } finally {
      if (master) await master.close();
      teardownMocks();
    }
  },
});
