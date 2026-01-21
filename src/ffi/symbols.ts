export const ethercrabSymbols = {
  // Platform Detection
  is_raw_socket_available: {
    parameters: [],
    result: "i32",
    // nonblocking: true, // Platform check is fast/sync
  },

  // Initialization
  ethercrab_init: {
    parameters: [
      "buffer", // interface: *const c_char
      "buffer", // expected_slaves: *const SlaveIdentity (not used for init but signature matches)
      "usize", // expected_count: usize
      "buffer", // init_commands: *const FfiInitCommand
      "usize", // init_command_count: usize
      "u64", // pdu_timeout_ms
      "u64", // state_transition_timeout_ms
      "u64", // mailbox_response_timeout_ms
      "u64", // eeprom_timeout_ms
      "usize", // pdu_retries
    ],
    result: "i32",
    nonblocking: true, // Async: Network I/O (Init sequence)
  },
  ethercrab_version: {
    parameters: [
      "buffer", // buffer: *mut u8
      "usize", // len: usize
    ],
    result: "i32", // bytes written
  },
  ethercrab_get_last_error: {
    parameters: [
      "buffer", // buffer: *mut u8
      "usize", // len: usize
    ],
    result: "i32", // bytes written
  },
  ethercrab_destroy: {
    parameters: [],
    result: "void",
    nonblocking: true, // Async: Waits for TX/RX thread to join (up to ~50-100ms)
  },

  // State & Topology
  ethercrab_verify_topology: {
    parameters: [
      "buffer", // expected: *const SlaveIdentity
      "usize", // expected_count: usize
    ],
    result: "i32",
    nonblocking: true, // Async: Checks state (memory-bound but kept async for consistency)
  },
  ethercrab_request_state: {
    parameters: ["u8"], // target_state
    result: "i32",
    nonblocking: true, // Async: Network I/O (State transition)
  },
  ethercrab_get_state: {
    parameters: [],
    result: "u8",
    // nonblocking: false, // Sync: Memory read (README item 1)
  },
  ethercrab_get_al_status_code: {
    parameters: ["u16"], // slave_idx
    result: "u16",
    nonblocking: true, // Async: Network I/O (Read register) - README item 5
  },

  // Cyclic / PDI - Note: Deno FFI struct returns are broken for pointers, use separate functions below
  ethercrab_get_pdi_buffer_ptr: {
    parameters: [],
    result: "pointer",
  },
  ethercrab_get_pdi_total_size: {
    parameters: [],
    result: "u32",
  },
  ethercrab_cyclic_tx_rx: {
    parameters: [],
    result: "i32", // WKC or error
    nonblocking: true, // Async: Network I/O (Cycle) - README item 4
  },

  // Mailbox / SDO / EEPROM
  ethercrab_configure_mailbox_polling: {
    parameters: ["u32"], // interval_ms
    result: "i32",
    // nonblocking: false, // Sync: Config update
  },
  ethercrab_check_mailbox: {
    parameters: [
      "u16", // slave_idx
      "u16", // status_addr
    ],
    result: "i32",
    nonblocking: true, // Async: Network I/O (Read register) - README item 5
  },
  ethercrab_check_mailbox_resilient: {
    parameters: [
      "u16", // slave_index
      "u16", // mailbox_status_addr
      "u8", // last_toggle_bit (0 or 1, or >1 for first run)
    ],
    result: "i32", // 0=Empty, 1=New Mail, -1=Error, -2=Retry Failed
    nonblocking: true, // Async: Network I/O (Read register)
  },
  ethercrab_sdo_read: {
    parameters: [
      "u16", // slave_index
      "u16", // index
      "u8", // sub_index
      "buffer", // data_out
      "usize", // max_len
    ],
    result: "i32", // bytes read or error
    nonblocking: true, // Async: Network I/O (SDO)
  },
  ethercrab_sdo_write: {
    parameters: [
      "u16", // slave_index
      "u16", // index
      "u8", // sub_index
      "buffer", // data
      "usize", // len
    ],
    result: "i32",
    nonblocking: true, // Async: Network I/O (SDO)
  },
  ethercrab_eeprom_read: {
    parameters: [
      "u16", // slave_index
      "u16", // address
      "buffer", // data_out
      "usize", // len
    ],
    result: "i32", // bytes read or error
    nonblocking: true, // Async: Network I/O (EEPROM)
  },
  ethercrab_get_last_emergency: {
    parameters: [
      "buffer", // out: *mut EmergencyInfo
    ],
    result: "i32",
    // nonblocking: false, // Sync: Memory read (README item 3)
  },
  ethercrab_write_process_data_byte: {
    parameters: ["u16", "u32", "u8"], // slave_index, byte_offset, value
    result: "i32", // 1 = success, 0 = failure
    // nonblocking: false, // Sync: Memory write (but uses block_on internally)
  },
  ethercrab_read_process_data_byte: {
    parameters: ["u16", "u32", "bool"], // slave_index, byte_offset, is_output
    result: "u8",
    // nonblocking: false, // Sync: Memory read (but uses block_on internally)
  },

  // Register Read/Write (for watchdog configuration etc.)
  ethercrab_register_read_u16: {
    parameters: ["u16", "u16"], // slave_index, register_address
    result: "i32", // value or error (negative)
    nonblocking: true, // Async: Network I/O (register read)
  },
  ethercrab_register_write_u16: {
    parameters: ["u16", "u16", "u16"], // slave_index, register_address, value
    result: "i32", // 0 = success, negative = error
    nonblocking: true, // Async: Network I/O (register write)
  },

  // Discovery
  ethercrab_scan_new: {
    parameters: ["buffer"], // interface: *const c_char
    result: "pointer", // *mut ScanContext
    nonblocking: true,
  },
  ethercrab_scan_get_slave_count: {
    parameters: ["pointer"],
    result: "u32",
  },
  ethercrab_scan_get_slave: {
    parameters: ["pointer", "u32", "buffer"], // ctx, idx, out_info
    result: "i32",
  },
  ethercrab_scan_get_pdo_count: {
    parameters: ["pointer", "u32"], // ctx, slave_idx
    result: "u32",
  },
  ethercrab_scan_get_pdo: {
    parameters: ["pointer", "u32", "u32", "buffer"], // ctx, slave_idx, pdo_pos, out_info
    result: "i32",
  },
  ethercrab_scan_get_pdo_entry_count: {
    parameters: ["pointer", "u32", "u32"], // ctx, slave_idx, pdo_pos
    result: "u32",
  },
  ethercrab_scan_get_pdo_entry: {
    parameters: ["pointer", "u32", "u32", "u32", "buffer"], // ctx, slave_idx, pdo_pos, entry_pos, out_info
    result: "i32",
  },
  ethercrab_scan_free: {
    parameters: ["pointer"],
    result: "void",
  },
} as const;

// Struct definitions for manual packing/unpacking if needed, or sizing
// SlaveIdentity: 4 * u32 = 16 bytes
export const SLAVE_IDENTITY_SIZE = 16;

// FfiInitCommand Layout (packed with padding for alignment):
// 0: slave_index (u16)
// 2: command_type (u8)
// 3: padding (1 byte) -> aligns next u16 to offset 4
// 4: index (u16)
// 6: sub_index (u8)
// 7: value ([u8; 4]) -> u8 array aligns to 1 byte
// 11: padding (1 byte) -> aligns struct size to multiple of 2
// Total: 12 bytes
export const INIT_COMMAND_SIZE = 12;

// EmergencyInfo
// slave_index: u16 (2)
// error_code: u16 (2)
// error_register: u8 (1)
// padding: 1
// Total: 6 bytes
export const EMERGENCY_INFO_SIZE = 6;

// Discovery Struct Sizes (aligned)
export const FFI_SLAVE_INFO_SIZE = 92; // 16 + 64 + 2 + 2 + 1 + 1 + 2 + 1 + 1 = 90 -> padded to 92
export const FFI_PDO_INFO_SIZE = 68; // 2 + 1 + 1 + 64 = 68
export const FFI_PDO_ENTRY_INFO_SIZE = 70; // 2 + 1 + 1 + 2 + 64 = 70
export const NAME_BUFFER_SIZE = 64;
