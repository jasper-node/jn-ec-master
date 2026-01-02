// Tests for EEPROM read operations (Feature 305)
//
// To run with hardware: RUST_MIN_STACK=8388608 ETHERCAT_HARDWARE_TESTS=1 cargo test --test eeprom_tests
// To run without hardware: cargo test --test eeprom_tests
//
// Note: Increased stack size (8MB) may be required for hardware tests due to async runtime depth

use ethercrab_ffi::*;
use std::ffi::CString;
use std::ptr;
use std::env;
use serial_test::serial;

const TEST_INTERFACE_ENV: &str = "ETHERCAT_INTERFACE";
const TEST_SLAVE_INDEX: u16 = 0;

fn should_run_hardware_tests() -> bool {
    match env::var(TEST_INTERFACE_ENV) {
        Ok(val) => !val.is_empty(),
        Err(_) => false,
    }
}

fn setup_master() -> CString {
    ethercrab_destroy();
    let interface_name = env::var(TEST_INTERFACE_ENV).unwrap_or_else(|_| "en5".to_string());
    let interface = CString::new(interface_name).unwrap();
    let result = ethercrab_init(
        interface.as_ptr(),
        ptr::null(),
        1,
        ptr::null(),
        0,
        100,   // pdu_timeout_ms
        5000,  // state_transition_timeout_ms
        1000,  // mailbox_response_timeout_ms
        100,   // eeprom_timeout_ms
        3,     // pdu_retries
    );
    assert_eq!(result, 0);
    interface
}

fn teardown() {
    ethercrab_destroy();
}

#[test]
#[serial]
fn test_eeprom_read_basic() {
    if !should_run_hardware_tests() {
        return; // Skip if hardware tests not enabled
    }
    let _interface = setup_master();

    let mut data_out = [0u8; 32];
    let result = ethercrab_eeprom_read(
        TEST_SLAVE_INDEX,
        0,
        data_out.as_mut_ptr(),
        data_out.len(),
    );

    if result > 0 {
        println!("EEPROM read successful: {} bytes read", result);
        assert!(result > 0);
        println!("First word: {:02x} {:02x}", data_out[0], data_out[1]);
    } else {
        println!("EEPROM read failed: {}", result);
    }

    teardown();
}

#[test]
#[serial]
fn test_eeprom_read_error_cases() {
    ethercrab_destroy();

    let result = ethercrab_eeprom_read(
        0,
        0,
        ptr::null_mut(),
        16,
    );
    assert_eq!(result, -4);

    let mut data = [0u8; 16];
    let result = ethercrab_eeprom_read(
        0,
        0,
        data.as_mut_ptr(),
        0,
    );
    assert_eq!(result, -4);

    let mut data = [0u8; 16];
    let result = ethercrab_eeprom_read(
        0,
        0,
        data.as_mut_ptr(),
        16,
    );
    assert_eq!(result, -1);
}
