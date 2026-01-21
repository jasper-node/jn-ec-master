// Integration tests for FFI functions
// Note: These tests require actual EtherCAT hardware connected to the system.
//
// USAGE:
//   With hardware: ETHERCAT_INTERFACE=<iface> cargo test --test integration_test -- --test-threads=1
//   Without hardware: cargo test --test integration_test (tests will be skipped)
//
// On macOS: Use the interface name from `ifconfig` (e.g., en0, en5)
//           May require running with sudo for raw socket access
// On Linux: Use interface name from `ip link` (e.g., eth0, enp0s31f6)
//           Requires CAP_NET_RAW or root privileges
//
// Example: sudo ETHERCAT_INTERFACE=en5 cargo test --test integration_test -- --test-threads=1
//
// Note: Tests use serial_test to ensure sequential execution for hardware access

use ethercrab_ffi::{
    is_raw_socket_available,
    ethercrab_get_state,
    ethercrab_get_pdi_buffer_ptr,
    ethercrab_get_pdi_total_size,
    ethercrab_get_last_error,
    ethercrab_init,
    ethercrab_destroy,
    ethercrab_request_state,
    ethercrab_cyclic_tx_rx,
    ethercrab_sdo_read,
    ethercrab_read_process_data_byte,
    ethercrab_register_read_u16,
    ethercrab_register_write_u16,
    ethercrab_scan_new,
    ethercrab_scan_get_slave_count,
    ethercrab_scan_get_slave,
    ethercrab_scan_get_pdo_count,
    ethercrab_scan_free,
    FfiSlaveInfo,
};
use std::env;
use std::ffi::CString;
use serial_test::serial;

const TEST_INTERFACE_ENV: &str = "ETHERCAT_INTERFACE";

// EtherCAT state constants
#[allow(dead_code)]
const STATE_INIT: u8 = 0;
const STATE_PREOP: u8 = 1;
const STATE_SAFEOP: u8 = 2;
const STATE_OP: u8 = 3;

// --- Helper Functions ---

fn should_run_hardware_tests() -> bool {
    env::var(TEST_INTERFACE_ENV).is_ok()
}

fn get_test_interface() -> Option<CString> {
    env::var(TEST_INTERFACE_ENV)
        .ok()
        .and_then(|s| CString::new(s).ok())
}

/// Helper to get the last error message
fn get_last_error() -> String {
    let mut buf = [0u8; 512];
    let len = ethercrab_get_last_error(buf.as_mut_ptr(), buf.len());
    if len > 0 {
        String::from_utf8_lossy(&buf[..len as usize]).to_string()
    } else {
        String::new()
    }
}

/// Setup hardware connection - returns true if successful
/// Note: This now properly cleans up any previous state before initializing,
/// matching the pattern used by the TypeScript wrapper.
fn setup_hardware() -> bool {
    // Check if already initialized (state > 0 means we have a connection)
    let current_state = ethercrab_get_state();
    if current_state > 0 {
        return true; // Already initialized, reuse existing connection
    }
    
    let interface = match get_test_interface() {
        Some(i) => i,
        None => return false,
    };
    
    // IMPORTANT: Clean up any previous partial initialization
    // This matches the TypeScript pattern in discoverNetwork() which calls
    // ethercrab_destroy() before ethercrab_scan_new() or ethercrab_init()
    ethercrab_destroy();
    
    // Small delay to allow cleanup to complete
    std::thread::sleep(std::time::Duration::from_millis(100));
    
    let result = ethercrab_init(
        interface.as_ptr(),
        std::ptr::null(),
        0,
        std::ptr::null(),
        0,
        100,   // pdu_timeout_ms
        5000,  // state_transition_timeout_ms
        1000,  // mailbox_response_timeout_ms
        100,   // eeprom_timeout_ms
        3,     // pdu_retries
    );
    
    if result != 0 {
        eprintln!("ethercrab_init returned {}, error: {}", result, get_last_error());
    }
    
    result == 0
}

/// Teardown hardware - properly cleans up the connection
fn teardown_hardware() {
    // Properly destroy the connection so subsequent tests start fresh
    ethercrab_destroy();
    // Small delay to allow cleanup to complete
    std::thread::sleep(std::time::Duration::from_millis(50));
}

#[test]
#[serial]
fn test_is_raw_socket_available() {
    if !should_run_hardware_tests() {
        return; // Skip if hardware tests not enabled
    }
    // This will return 0 or 1 depending on platform capabilities
    let result = is_raw_socket_available();
    assert!(result == 0 || result == 1);
}

#[test]
#[serial]
fn test_ethercrab_get_state_uninitialized() {
    if !should_run_hardware_tests() {
        return; // Skip if hardware tests not enabled
    }
    // Note: If another test already initialized, state will be > 0
    // This test validates state query works, not specifically uninitialized state
    let state = ethercrab_get_state();
    // State should be a valid value (0-3)
    assert!(state <= 3, "State should be 0-3, got {}", state);
    println!("Current state: {}", state);
}

#[test]
#[serial]
fn test_ethercrab_get_pdi_uninitialized() {
    if !should_run_hardware_tests() {
        return; // Skip if hardware tests not enabled
    }
    // Note: If another test already initialized, PDI will be valid
    // This test validates PDI query works
    let ptr = ethercrab_get_pdi_buffer_ptr();
    let size = ethercrab_get_pdi_total_size();
    println!("PDI ptr: {:?}, size: {}", ptr, size);
    // Just verify the call doesn't crash - values depend on init state
}

// =============================================================================
// Hardware Connection and State Transition Tests
// =============================================================================

#[test]
#[serial]
fn test_hardware_init_and_discovery() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    // Initialize hardware (or reuse existing connection)
    assert!(setup_hardware(), "Failed to initialize hardware");
    
    // After init/reuse, state should be valid (PreOp or higher)
    let state = ethercrab_get_state();
    assert!(state >= STATE_PREOP, "Expected PreOp or higher state, got {}", state);
    println!("Hardware initialized, state: {}", state);
    
    teardown_hardware();
}

#[test]
#[serial]
fn test_state_transitions() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    assert!(setup_hardware(), "Failed to initialize hardware");
    
    let current_state = ethercrab_get_state();
    println!("Current state: {}", current_state);
    
    // If already in Op, test is effectively done (previous test left it there)
    if current_state == STATE_OP {
        println!("Already in OP state from previous test - verifying state is stable");
        // Run a cycle to verify Op state is working
        let wkc = ethercrab_cyclic_tx_rx();
        assert!(wkc >= 0, "Op state should allow cyclic communication");
        teardown_hardware();
        return;
    }
    
    // If in PreOp, do full transition test
    if current_state == STATE_PREOP {
        // Transition to SafeOp
        let result = ethercrab_request_state(STATE_SAFEOP);
        assert_eq!(result, 0, "Failed to transition to SafeOp");
        assert_eq!(ethercrab_get_state(), STATE_SAFEOP);
    }
    
    // If in SafeOp or just transitioned, go to Op
    if ethercrab_get_state() == STATE_SAFEOP {
        let result = ethercrab_request_state(STATE_OP);
        assert_eq!(result, 0, "Failed to transition to Op");
        assert_eq!(ethercrab_get_state(), STATE_OP);
    }
    
    teardown_hardware();
}

// =============================================================================
// Cyclic Communication Tests
// =============================================================================

#[test]
#[serial]
fn test_pdi_buffer_populated() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    assert!(setup_hardware(), "Failed to initialize hardware");
    
    // Transition to SafeOp to populate PDI
    let result = ethercrab_request_state(STATE_SAFEOP);
    assert_eq!(result, 0, "Failed to transition to SafeOp");
    
    // PDI buffer should now be valid
    let ptr = ethercrab_get_pdi_buffer_ptr();
    let size = ethercrab_get_pdi_total_size();
    
    // Note: Some slaves (like EK1100 couplers) may have 0 PDI size
    // But the pointer should be valid
    println!("PDI buffer ptr: {:?}, size: {}", ptr, size);
    
    // If there's actual I/O, size should be > 0
    // We don't assert on size since it depends on connected hardware
    
    teardown_hardware();
}

#[test]
#[serial]
fn test_cyclic_tx_rx_in_op() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    assert!(setup_hardware(), "Failed to initialize hardware");
    
    // Transition to Op
    assert_eq!(ethercrab_request_state(STATE_SAFEOP), 0);
    assert_eq!(ethercrab_request_state(STATE_OP), 0);
    
    // Run several cyclic exchanges
    for i in 0..10 {
        let wkc = ethercrab_cyclic_tx_rx();
        println!("Cycle {}: WKC = {}", i, wkc);
        
        // WKC should be positive (indicates successful communication)
        // A negative value indicates error
        assert!(wkc >= 0, "Cyclic tx_rx returned error: {}", wkc);
        
        // Small delay between cycles
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    
    teardown_hardware();
}

#[test]
#[serial]
fn test_read_process_data_bytes() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    assert!(setup_hardware(), "Failed to initialize hardware");
    
    // Transition to Op
    assert_eq!(ethercrab_request_state(STATE_SAFEOP), 0);
    assert_eq!(ethercrab_request_state(STATE_OP), 0);
    
    // Run a cycle to get fresh data
    let wkc = ethercrab_cyclic_tx_rx();
    assert!(wkc >= 0, "Cyclic tx_rx failed");
    
    // Try to read first few bytes of input data from slave 0
    // This tests the per-slave process data read function
    let pdi_size = ethercrab_get_pdi_total_size();
    if pdi_size > 0 {
        // Read first input byte from slave 0
        let byte0 = ethercrab_read_process_data_byte(0, 0, false);
        println!("Slave 0, Input byte 0: 0x{:02X}", byte0);
        
        // Read first output byte from slave 0 (if any)
        let out_byte0 = ethercrab_read_process_data_byte(0, 0, true);
        println!("Slave 0, Output byte 0: 0x{:02X}", out_byte0);
    } else {
        println!("No PDI data available (coupler-only setup?)");
    }
    
    teardown_hardware();
}

// =============================================================================
// SDO Communication Tests
// =============================================================================

#[test]
#[serial]
fn test_sdo_read_identity() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    assert!(setup_hardware(), "Failed to initialize hardware");
    
    // Read identity object (0x1018) from first slave
    // Sub-index 1 = Vendor ID (4 bytes)
    let mut data = [0u8; 4];
    let result = ethercrab_sdo_read(
        0,      // slave_index
        0x1018, // index - Identity object
        1,      // sub_index - Vendor ID
        data.as_mut_ptr(),
        4,
    );
    
    if result > 0 {
        let vendor_id = u32::from_le_bytes(data);
        println!("Slave 0 Vendor ID: 0x{:08X}", vendor_id);
        // Common vendor IDs: Beckhoff = 0x00000002
        assert!(vendor_id > 0, "Vendor ID should be non-zero");
    } else {
        // Some slaves may not support CoE, which is acceptable
        println!("SDO read returned {}, slave may not support CoE", result);
    }
    
    // Read Product Code (sub-index 2)
    let result = ethercrab_sdo_read(
        0,
        0x1018,
        2, // Product Code
        data.as_mut_ptr(),
        4,
    );
    
    if result > 0 {
        let product_code = u32::from_le_bytes(data);
        println!("Slave 0 Product Code: 0x{:08X}", product_code);
    }
    
    teardown_hardware();
}

// =============================================================================
// Register Read/Write Tests
// Tests reading EtherCAT register addresses (ETG1000.4 Table 31)
// =============================================================================

#[test]
#[serial]
fn test_register_read_watchdog_registers() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    assert!(setup_hardware(), "Failed to initialize hardware");
    
    // Test reading watchdog-related registers from slave 0
    // These registers are defined in ETG1000.4 Table 31
    
    // 0x0400: Watchdog Divider (default ~2498, gives ~100µs per count)
    let watchdog_divider = ethercrab_register_read_u16(0, 0x0400);
    if watchdog_divider > 0 {
        println!("Slave 0 Watchdog Divider (0x0400): {}", watchdog_divider);
        // Typical values are around 2498, but we just verify it's readable
        assert!(watchdog_divider > 0, "Watchdog divider should be positive");
    } else {
        println!("Watchdog divider read failed (returned {})", watchdog_divider);
    }
    
    // 0x0410: PDI Watchdog timeout
    let pdi_watchdog = ethercrab_register_read_u16(0, 0x0410);
    if pdi_watchdog > 0 {
        println!("Slave 0 PDI Watchdog (0x0410): {}", pdi_watchdog);
    } else {
        println!("PDI Watchdog read failed (returned {})", pdi_watchdog);
    }
    
    // 0x0420: SM Watchdog timeout (default ~1000 with default divider = ~100ms)
    let sm_watchdog = ethercrab_register_read_u16(0, 0x0420);
    if sm_watchdog > 0 {
        println!("Slave 0 SM Watchdog (0x0420): {}", sm_watchdog);
    } else {
        println!("SM Watchdog read failed (returned {})", sm_watchdog);
    }
    
    // 0x0440: SM Watchdog status (1 bit)
    let sm_watchdog_status = ethercrab_register_read_u16(0, 0x0440);
    if sm_watchdog_status >= 0 {
        println!("Slave 0 SM Watchdog Status (0x0440): 0x{:04X}", sm_watchdog_status as u16);
    } else {
        println!("SM Watchdog status read failed (returned {})", sm_watchdog_status);
    }
    
    teardown_hardware();
}

#[test]
#[serial]
fn test_register_write_read_roundtrip() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    assert!(setup_hardware(), "Failed to initialize hardware");
    
    // Read current watchdog divider value
    let original_value = ethercrab_register_read_u16(0, 0x0400);
    if original_value <= 0 {
        println!("Cannot read watchdog divider, skipping write test");
        teardown_hardware();
        return;
    }
    
    println!("Original Watchdog Divider: {}", original_value);
    
    // Write the same value back (safe roundtrip test)
    let write_result = ethercrab_register_write_u16(0, 0x0400, original_value as u16);
    if write_result == 0 {
        println!("Successfully wrote watchdog divider");
        
        // Read back to verify
        let read_back = ethercrab_register_read_u16(0, 0x0400);
        if read_back > 0 {
            assert_eq!(read_back, original_value, "Roundtrip read/write should preserve value");
            println!("Roundtrip test passed: wrote {} and read back {}", original_value, read_back);
        }
    } else {
        println!("Write failed (returned {}), may not be writable or require different state", write_result);
    }
    
    teardown_hardware();
}

// =============================================================================
// Network Discovery/Scan Tests
// Note: Scan tests require the network interface to be available and configured.
// On macOS, you may need to run with sudo for raw socket access.
// =============================================================================

#[test]
#[serial]
fn test_scan_network() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    let interface = get_test_interface().expect("Interface required");
    
    // IMPORTANT: Clean up any previous state before scanning
    // The scan API uses separate resources but checks if STATE is locked
    ethercrab_destroy();
    std::thread::sleep(std::time::Duration::from_millis(100));
    
    // Perform network scan
    let ctx = ethercrab_scan_new(interface.as_ptr());
    if ctx.is_null() {
        let error = get_last_error();
        panic!("Scan returned null - error: {} (check interface name and permissions)", error);
    }
    
    // Get slave count
    let slave_count = ethercrab_scan_get_slave_count(ctx);
    println!("Discovered {} slaves", slave_count);
    assert!(slave_count > 0, "Expected at least one slave");
    
    // Clean up
    ethercrab_scan_free(ctx);
}

#[test]
#[serial]
fn test_scan_get_slave_info() {
    if !should_run_hardware_tests() {
        println!("Skipping hardware test - ETHERCAT_INTERFACE not set");
        return;
    }
    
    let interface = get_test_interface().expect("Interface required");
    
    // IMPORTANT: Clean up any previous state before scanning
    ethercrab_destroy();
    std::thread::sleep(std::time::Duration::from_millis(100));
    
    let ctx = ethercrab_scan_new(interface.as_ptr());
    if ctx.is_null() {
        let error = get_last_error();
        panic!("Scan returned null - error: {} (check interface name and permissions)", error);
    }
    
    let slave_count = ethercrab_scan_get_slave_count(ctx);
    assert!(slave_count > 0, "Expected at least one slave for this test");
    
    // Get info for each discovered slave
    for i in 0..slave_count {
        let mut info = FfiSlaveInfo {
            identity: ethercrab_ffi::SlaveIdentity {
                vendor_id: 0,
                product_code: 0,
                revision: 0,
                serial_number: 0,
            },
            name: [0u8; 64],
            configured_address: 0,
            alias_address: 0,
            port_count: 0,
            _padding: [0],
            mailbox_protocols: 0,
            dc_supported: 0,
            _padding2: [0],
        };
        
        let result = ethercrab_scan_get_slave(ctx, i, &mut info);
        assert_eq!(result, 0, "Failed to get slave {} info", i);
        
        // Convert name to string
        let name_end = info.name.iter().position(|&b| b == 0).unwrap_or(64);
        let name = String::from_utf8_lossy(&info.name[..name_end]);
        
        println!(
            "Slave {}: {} (Vendor: 0x{:08X}, Product: 0x{:08X}, Addr: {})",
            i,
            name,
            info.identity.vendor_id,
            info.identity.product_code,
            info.configured_address
        );
        
        // Get PDO count for this slave
        let pdo_count = ethercrab_scan_get_pdo_count(ctx, i);
        println!("  PDO count: {}", pdo_count);
    }
    
    ethercrab_scan_free(ctx);
}

#[test]
#[serial]
fn test_scan_free_null_safe() {
    // Ensure scan_free handles null gracefully
    ethercrab_scan_free(std::ptr::null_mut());
    // No crash = success
}

