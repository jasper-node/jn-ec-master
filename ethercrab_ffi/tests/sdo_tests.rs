// Tests for SDO read/write operations (Feature 501)
//
// To run with hardware: RUST_MIN_STACK=8388608 ETHERCAT_HARDWARE_TESTS=1 cargo test --test sdo_tests
// To run without hardware: cargo test --test sdo_tests
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
    );
    assert_eq!(result, 0);
    interface
}

fn teardown() {
    ethercrab_destroy();
}

#[test]
#[serial]
fn test_sdo_read_basic() {
    if !should_run_hardware_tests() {
        return; // Skip if hardware tests not enabled
    }
    let _interface = setup_master();
    let state = ethercrab_get_state();
    assert!(state >= 1);

    let mut data_out = [0u8; 4];
    let result = ethercrab_sdo_read(
        TEST_SLAVE_INDEX,
        0x1008,
        0,
        data_out.as_mut_ptr(),
        data_out.len(),
    );

    if result > 0 {
        println!("SDO read successful: {} bytes read, data: {:?}", result, &data_out[..result as usize]);
        assert!(result > 0 && result <= 4);
    } else {
        println!("SDO read returned error: {}", result);
        assert!(result < 0);
    }

    teardown();
}

#[test]
#[serial]
fn test_sdo_write_basic() {
    if !should_run_hardware_tests() {
        return; // Skip if hardware tests not enabled
    }
    let _interface = setup_master();

    let data = [0x01u8, 0x00, 0x00, 0x00];
    let result = ethercrab_sdo_write(
        TEST_SLAVE_INDEX,
        0x1008,
        0,
        data.as_ptr(),
        4,
    );

    println!("SDO write result: {}", result);
    assert!(result < 0, "Expected failure for read-only SDO");

    teardown();
}

#[test]
#[serial]
fn test_sdo_read_error_cases() {
    ethercrab_destroy();

    let result = ethercrab_sdo_read(
        0,
        0x1008,
        0,
        ptr::null_mut(),
        4,
    );
    assert_eq!(result, -4);

    let mut data = [0u8; 4];
    let result = ethercrab_sdo_read(
        0,
        0x1008,
        0,
        data.as_mut_ptr(),
        0,
    );
    assert_eq!(result, -4);

    let mut data = [0u8; 4];
    let result = ethercrab_sdo_read(
        0,
        0x1008,
        0,
        data.as_mut_ptr(),
        4,
    );
    assert_eq!(result, -1);
}

#[test]
#[serial]
fn test_sdo_write_error_cases() {
    ethercrab_destroy();

    let result = ethercrab_sdo_write(
        0,
        0x1008,
        0,
        ptr::null(),
        4,
    );
    assert_eq!(result, -4);

    let data = [0u8; 4];
    let result = ethercrab_sdo_write(
        0,
        0x1008,
        0,
        data.as_ptr(),
        0,
    );
    assert_eq!(result, -4);

    let data = [0u8; 5];
    let result = ethercrab_sdo_write(
        0,
        0x1008,
        0,
        data.as_ptr(),
        5,
    );
    assert_eq!(result, -4);
}

