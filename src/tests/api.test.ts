import { assert, assertEquals } from "@std/assert";
import { EcMaster, SlaveState } from "../ec_master.ts";
import { EniConfig } from "../types/eni-config.ts";

// Mock Setup
const originalDlopen = Deno.dlopen;
const originalUnsafePointerView = Deno.UnsafePointerView;

function setupMocks() {
  // Mock pointer value for tests
  const mockPointer = { __brand: "pointer" };

  // Mock Deno.dlopen
  // @ts-ignore
  Deno.dlopen = (_path: string, _symbols: any) => {
    return {
      symbols: {
        ethercrab_init: (_iface: any, _slaves: any, _count: any, _cmds: any, _cmdCount: any) =>
          Promise.resolve(0),
        ethercrab_destroy: () => {},
        ethercrab_verify_topology: (_expected: any, _count: any) => Promise.resolve(0),
        ethercrab_request_state: (_state: any) => Promise.resolve(0),
        ethercrab_get_state: () => SlaveState.OP, // Sync
        ethercrab_get_al_status_code: (_idx: any) => Promise.resolve(0),
        // PDI buffer access (separate functions due to Deno FFI struct issues)
        ethercrab_get_pdi_total_size: () => 20, // Sync - returns total PDI size
        ethercrab_get_pdi_buffer_ptr: () => mockPointer, // Sync - returns mock pointer
        ethercrab_cyclic_tx_rx: () => Promise.resolve(0),
        ethercrab_write_process_data_byte: (_slaveIndex: any, _byteOffset: any, _value: any) => 1, // Sync - returns 1 for success
        ethercrab_read_process_data_byte: (_slaveIndex: any, _byteOffset: any, _isOutput: any) =>
          0xFF, // Sync - returns test value
        ethercrab_configure_mailbox_polling: (_interval: any) => 0, // Sync
        ethercrab_check_mailbox: (_idx: any, _addr: any) => Promise.resolve(0),
        ethercrab_sdo_read: (_idx: any, _i: any, _si: any, _buf: any, _len: any) =>
          Promise.resolve(4),
        ethercrab_sdo_write: (_idx: any, _i: any, _si: any, _data: any, _len: any) =>
          Promise.resolve(0),
        ethercrab_eeprom_read: (_idx: any, _addr: any, _buf: any, _len: any) => Promise.resolve(2),
        ethercrab_get_last_emergency: (_buf: any) => 0, // Sync
        is_raw_socket_available: () => 1, // Sync
        ethercrab_get_last_error: (_buf: any, _len: any) => 0, // Sync
        ethercrab_version: (buf: Uint8Array, _len: any) => {
          const version = "0.1.1";
          const encoded = new TextEncoder().encode(version);
          buf.set(encoded);
          return encoded.length;
        },
      },
      close: () => {},
    };
  };

  // Mock Deno.UnsafePointerView
  // @ts-ignore
  Deno.UnsafePointerView = class {
    static getArrayBuffer(_ptr: any, len: number) {
      return new Uint8Array(len).buffer;
    }
    static getCString(_ptr: any) {
      return "";
    }
  };

  // Mock Deno.UnsafePointer
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

const validConfig: EniConfig = {
  master: { cycleTime: 1000, runtimeOptions: { networkInterface: "test-iface" } },
  slaves: [
    {
      name: "Slave1",
      vendorId: 1,
      productCode: 2,
      initCommands: [],
    },
  ],
  processData: {
    inputSize: 4,
    outputSize: 4,
    mappings: [],
  },
};

Deno.test({
  name: "EcMaster - Instantiate and Initialize (Mocked)",
  fn: async () => {
    setupMocks();
    try {
      const master = new EcMaster(validConfig);
      await master.initialize();

      // Check PDI buffer availability
      const buffer = master.getProcessDataBuffer();
      assertEquals(buffer.byteLength, 20); // From mock return value [10, 10, 20, ptr]

      master.close();
    } finally {
      teardownMocks();
    }
  },
});

Deno.test({
  name: "EcMaster - Process Data Access (writePdoByte/readPdoByte/getProcessDataBuffer)",
  fn: async () => {
    setupMocks();
    try {
      const master = new EcMaster(validConfig);
      await master.initialize();

      // Test writePdoByte - write to slave 0, byte 0
      const success = master.writePdoByte(0, 0, 0xFF);
      assert(success, "writePdoByte should succeed");

      // Test readPdoByte - read back the value we just wrote
      const value = master.readPdoByte(0, 0, true); // isOutput = true
      assertEquals(value, 0xFF, "readPdoByte should return written value");

      // Test getProcessDataBuffer for reading inputs
      const buffer = master.getProcessDataBuffer();
      assertEquals(buffer.byteLength, 20, "Buffer should have correct size");

      master.close();
    } finally {
      teardownMocks();
    }
  },
});

Deno.test({
  name: "EcMaster - State Transition Emits Event",
  fn: async () => {
    setupMocks();
    try {
      const master = new EcMaster(validConfig);
      // Initialize usually needed for state? Actually logic doesn't strictly require initialize() for requestState
      // if the FFI allows it, but typically we init first.
      // However, requestState calls FFI which is mocked.

      let eventFired = false;
      master.on("stateChange", (evt) => {
        eventFired = true;
        assertEquals(evt.currentState, SlaveState.OP);
      });

      await master.requestState(SlaveState.OP);

      assert(eventFired, "stateChange event should have fired");

      master.close();
    } finally {
      teardownMocks();
    }
  },
});

Deno.test({
  name: "EcMaster - Verify Topology Check",
  fn: async () => {
    setupMocks();
    try {
      const master = new EcMaster(validConfig);
      // Should pass as mock returns 0
      await master.verifyTopology();
      master.close();
    } finally {
      teardownMocks();
    }
  },
});

Deno.test({
  name: "EcMaster - isRawSocketAvailable",
  fn: async () => {
    setupMocks();
    try {
      const master = new EcMaster(validConfig);
      const result = await master.isRawSocketAvailable();
      assertEquals(result, true);
      master.close();
    } finally {
      teardownMocks();
    }
  },
});
