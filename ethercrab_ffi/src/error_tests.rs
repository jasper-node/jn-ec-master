use super::*;
use serial_test::serial;

/// Reset the error ring between tests to avoid cross-contamination
fn reset_error_ring() {
    let mut ring = ERROR_RING.lock();
    *ring = ErrorRing::new();
}

#[test]
#[serial]
fn test_error_ring_stores_entries() {
    reset_error_ring();
    set_error("first error");
    set_error("second error");

    let ring = ERROR_RING.lock();
    assert_eq!(ring.total_count, 2);
    assert_eq!(ring.latest().unwrap().message, "second error");
}

#[test]
#[serial]
fn test_error_ring_wraps_around() {
    reset_error_ring();
    for i in 0..20 {
        set_error(format!("error {}", i));
    }

    let ring = ERROR_RING.lock();
    assert_eq!(ring.total_count, 20);
    assert_eq!(ring.latest().unwrap().message, "error 19");
    assert_eq!(ring.get(0).unwrap().message, "error 4");
    assert!(ring.get(ERROR_RING_SIZE).is_none());
}

#[test]
#[serial]
fn test_error_ring_get_indexing() {
    reset_error_ring();
    set_error("a");
    set_error("b");
    set_error("c");

    let ring = ERROR_RING.lock();
    assert_eq!(ring.get(0).unwrap().message, "a");
    assert_eq!(ring.get(1).unwrap().message, "b");
    assert_eq!(ring.get(2).unwrap().message, "c");
    assert!(ring.get(3).is_none());
}

#[test]
#[serial]
fn test_set_error_ctx_stores_code_and_context() {
    reset_error_ring();
    set_error_ctx(
        FfiErrorCode::PduTimeout,
        "test timeout",
        &[("op", "cyclic_tx_rx"), ("expected_wkc", "3")],
    );

    let ring = ERROR_RING.lock();
    let entry = ring.latest().unwrap();
    assert_eq!(entry.message, "test timeout");
    assert!(matches!(entry.code, FfiErrorCode::PduTimeout));
    assert!(entry.context_json.contains("\"op\":\"cyclic_tx_rx\""));
    assert!(entry.context_json.contains("\"expected_wkc\":\"3\""));
}

#[test]
#[serial]
fn test_set_error_ctx_empty_context() {
    reset_error_ring();
    set_error_ctx(FfiErrorCode::NotInitialized, "no context", &[]);

    let ring = ERROR_RING.lock();
    let entry = ring.latest().unwrap();
    assert!(entry.context_json.is_empty());
}

#[test]
fn test_json_escape() {
    assert_eq!(json_escape("hello"), "hello");
    assert_eq!(json_escape("he\"llo"), "he\\\"llo");
    assert_eq!(json_escape("line\nnew"), "line\\nnew");
    assert_eq!(json_escape("tab\there"), "tab\\there");
    assert_eq!(json_escape("back\\slash"), "back\\\\slash");
}

#[test]
fn test_build_context_json() {
    let json = build_context_json(&[("key1", "val1"), ("key2", "val2")]);
    assert_eq!(json, r#"{"key1":"val1","key2":"val2"}"#);
}

#[test]
fn test_build_context_json_with_special_chars() {
    let json = build_context_json(&[("error", "Timeout(\"Pdu\")")]);
    assert_eq!(json, r#"{"error":"Timeout(\"Pdu\")"}"#);
}

#[test]
fn test_build_context_json_empty() {
    assert_eq!(build_context_json(&[]), "");
}

#[test]
fn test_format_error_for_ffi_without_context() {
    let entry = ErrorEntry {
        code: FfiErrorCode::Unspecified,
        message: "simple error".to_string(),
        context_json: String::new(),
        timestamp_ms: 0,
    };
    assert_eq!(format_error_for_ffi(&entry), "simple error");
}

#[test]
fn test_format_error_for_ffi_with_context() {
    let entry = ErrorEntry {
        code: FfiErrorCode::PduTimeout,
        message: "tx_rx failed".to_string(),
        context_json: r#"{"op":"cyclic"}"#.to_string(),
        timestamp_ms: 100,
    };
    assert_eq!(format_error_for_ffi(&entry), r#"tx_rx failed||{"op":"cyclic"}"#);
}

#[test]
fn test_state_name() {
    assert_eq!(state_name(0), "Init");
    assert_eq!(state_name(1), "PreOp");
    assert_eq!(state_name(2), "SafeOp");
    assert_eq!(state_name(3), "Op");
    assert_eq!(state_name(99), "Unknown");
}

#[test]
#[serial]
fn test_ffi_get_last_error_reads_from_ring() {
    reset_error_ring();
    set_error_ctx(
        FfiErrorCode::SdoError,
        "SDO failed",
        &[("slave_index", "2")],
    );

    let mut buf = [0u8; 256];
    let len = ethercrab_get_last_error(buf.as_mut_ptr(), buf.len());
    assert!(len > 0);
    let msg = std::str::from_utf8(&buf[..len as usize]).unwrap();
    assert!(msg.starts_with("SDO failed"));
    assert!(msg.contains("||"));
    assert!(msg.contains("\"slave_index\":\"2\""));
}

#[test]
#[serial]
fn test_ffi_get_last_error_empty_ring() {
    reset_error_ring();
    let mut buf = [0u8; 256];
    let len = ethercrab_get_last_error(buf.as_mut_ptr(), buf.len());
    assert_eq!(len, 0);
}

#[test]
#[serial]
fn test_ffi_get_network_healthy() {
    NETWORK_HEALTHY.store(true, Ordering::Relaxed);
    assert_eq!(ethercrab_get_network_healthy(), 1);

    NETWORK_HEALTHY.store(false, Ordering::Relaxed);
    assert_eq!(ethercrab_get_network_healthy(), 0);

    // Restore
    NETWORK_HEALTHY.store(true, Ordering::Relaxed);
}

#[test]
#[serial]
fn test_ffi_get_error_count() {
    reset_error_ring();
    assert_eq!(ethercrab_get_error_count(), 0);

    set_error("err1");
    set_error("err2");
    assert_eq!(ethercrab_get_error_count(), 2);
}

#[test]
#[serial]
fn test_ffi_get_error_detail_latest() {
    reset_error_ring();
    set_error_ctx(FfiErrorCode::PduTimeout, "timeout", &[("op", "tx_rx")]);

    let mut buf = [0u8; 512];
    let len = ethercrab_get_error_detail(buf.as_mut_ptr(), buf.len(), -1);
    assert!(len > 0);
    let json = std::str::from_utf8(&buf[..len as usize]).unwrap();
    assert!(json.contains("\"code\":10")); // PduTimeout = 10
    assert!(json.contains("\"message\":\"timeout\""));
    assert!(json.contains("\"op\":\"tx_rx\""));
    assert!(json.contains("\"timestamp_ms\":"));
}

#[test]
#[serial]
fn test_ffi_get_error_detail_empty() {
    reset_error_ring();
    let mut buf = [0u8; 512];
    let len = ethercrab_get_error_detail(buf.as_mut_ptr(), buf.len(), -1);
    assert_eq!(len, 0);
}

#[test]
#[serial]
fn test_legacy_set_error_uses_unspecified_code() {
    reset_error_ring();
    set_error("legacy error");

    let ring = ERROR_RING.lock();
    let entry = ring.latest().unwrap();
    assert!(matches!(entry.code, FfiErrorCode::Unspecified));
    assert!(entry.context_json.is_empty());
}

#[test]
#[serial]
fn test_error_ring_timestamps_increase() {
    reset_error_ring();
    set_error("first");
    std::thread::sleep(std::time::Duration::from_millis(2));
    set_error("second");

    let ring = ERROR_RING.lock();
    let first = ring.get(0).unwrap();
    let second = ring.get(1).unwrap();
    assert!(second.timestamp_ms >= first.timestamp_ms);
}
