// Tests for emergency message handling
//
// To run with hardware: RUST_MIN_STACK=8388608 ETHERCAT_HARDWARE_TESTS=1 cargo test --test emergency_tests
// To run without hardware: cargo test --test emergency_tests
//
// Note: Increased stack size (8MB) may be required for hardware tests due to async runtime depth

use ethercrab_ffi::*;
use std::ffi::CString;
use std::ptr;
use std::env;
use serial_test::serial;

const TEST_INTERFACE_ENV: &str = "ETHERCAT_INTERFACE";

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
    );
    assert_eq!(result, 0);
    interface
}

fn teardown() {
    ethercrab_destroy();
}

#[test]
#[serial]
fn test_emergency_handling() {
    if !should_run_hardware_tests() {
        return; // Skip if hardware tests not enabled
    }
    let _interface = setup_master();

    let mut emergency_info = EmergencyInfo {
        slave_index: 0,
        error_code: 0,
        error_register: 0,
    };

    let result = ethercrab_get_last_emergency(&mut emergency_info);

    if result == -1 {
        println!("No emergency recorded (expected initially)");
    } else if result == 0 {
        println!("Emergency recorded: slave={}, code={:04x}, reg={:02x}",
                 emergency_info.slave_index,
                 emergency_info.error_code,
                 emergency_info.error_register);
    }

    teardown();
}

#[test]
#[serial]
fn test_emergency_get_error_cases() {
    ethercrab_destroy();

    let result = ethercrab_get_last_emergency(ptr::null_mut());
    assert_eq!(result, -1);

    let mut emergency_info = EmergencyInfo {
        slave_index: 0,
        error_code: 0,
        error_register: 0,
    };
    let result = ethercrab_get_last_emergency(&mut emergency_info);
    assert_eq!(result, -1);
}
