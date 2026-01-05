use std::ffi::{CStr, c_char, c_int};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use ethercrab::{
    MainDevice, MainDeviceConfig, PduStorage, Timeouts, std::ethercat_now,
    subdevice_group::{PreOp, SafeOp, Op},
};
use ethercrab::subdevice_group::SubDeviceGroup;
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::{Mutex, RwLock};
use smol;
use futures_lite::future;

// --- Constants ---
const MAX_SUBDEVICES: usize = 128;
const MAX_PDU_DATA: usize = PduStorage::element_size(1100);
const MAX_FRAMES: usize = 16;
const MAX_PDI: usize = 4096;

// --- Static Storage ---
static PDU_STORAGE: PduStorage<MAX_FRAMES, MAX_PDU_DATA> = PduStorage::new();

// --- State Definitions ---
enum GroupState {
    PreOp(SubDeviceGroup<MAX_SUBDEVICES, MAX_PDI, spin::rwlock::RwLock<(), spin::Yield>, PreOp>),
    SafeOp(SubDeviceGroup<MAX_SUBDEVICES, MAX_PDI, spin::rwlock::RwLock<(), spin::Yield>, SafeOp>),
    Op(SubDeviceGroup<MAX_SUBDEVICES, MAX_PDI, spin::rwlock::RwLock<(), spin::Yield>, Op>),
}

struct EcMasterState {
    maindevice: Arc<MainDevice<'static>>,
    group: Option<GroupState>,
    // Wrapped in RwLock for interior mutability, Arc for stable address
    pdi_buffer: Arc<RwLock<[u8; MAX_PDI]>>, 
    pdi_size: usize,
    input_size: usize,
    output_size: usize,
    expected_wkc: u16,
    mailbox_poll_interval_ms: Option<u32>,
}

#[derive(Clone, Copy)]
struct InternalEmergencyInfo {
    slave_index: u16,
    error_code: u16,
    error_register: u8,
}

// --- Global State ---
static STATE: Lazy<RwLock<Option<EcMasterState>>> = Lazy::new(|| RwLock::new(None));
static GLOBAL_DEVICE: OnceCell<Arc<MainDevice<'static>>> = OnceCell::new();
static LAST_ERROR: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static LAST_EMERGENCY: Lazy<Mutex<Option<InternalEmergencyInfo>>> = Lazy::new(|| Mutex::new(None));
static NETWORK_HEALTHY: AtomicBool = AtomicBool::new(true);

fn set_error(err: impl std::fmt::Display) {
    let mut guard = LAST_ERROR.lock();
    *guard = err.to_string();
}

// --- FFI Structs ---
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SlaveIdentity {
    pub vendor_id: u32,
    pub product_code: u32,
    pub revision: u32,
    pub serial_number: u32,
}


#[repr(C)]
#[derive(Clone, Copy)]
// Layout matches TypeScript definition (12 bytes total):
// offset 0: slave_index (u16)
// offset 2: command_type (u8)
// offset 3: padding (1 byte)
// offset 4: index (u16)
// offset 6: sub_index (u8)
// offset 7: value ([u8; 4])
// offset 11: padding (1 byte)
pub struct FfiInitCommand {
    pub slave_index: u16,
    pub command_type: u8, // 0=SDO, 1=Register
    pub index: u16,
    pub sub_index: u8,
    pub value: [u8; 4],
}

#[repr(C)]
pub struct EmergencyInfo {
    pub slave_index: u16,
    pub error_code: u16,
    pub error_register: u8,
}

// --- SDO Info Structures (ETG1000.6 §5.6.3.3.1) ---

/// Object access flags bitfield (ETG1000.6 §5.6.2.5)
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ObjectAccess {
    flags: u16,
}

impl ObjectAccess {
    pub fn from_u16(flags: u16) -> Self {
        Self { flags }
    }
    
    pub fn read_access(&self) -> bool {
        (self.flags & 0x0001) != 0
    }
    
    pub fn write_access(&self) -> bool {
        (self.flags & 0x0002) != 0
    }
    
    pub fn rx_pdo_mapping(&self) -> bool {
        (self.flags & 0x0004) != 0
    }
    
    pub fn tx_pdo_mapping(&self) -> bool {
        (self.flags & 0x0008) != 0
    }
    
    pub fn backup_param(&self) -> bool {
        (self.flags & 0x0010) != 0
    }
    
    pub fn settings_param(&self) -> bool {
        (self.flags & 0x0020) != 0
    }
}

// --- Helper Functions ---

fn u32_from_bytes(bytes: [u8; 4]) -> u32 {
    u32::from_le_bytes(bytes)
}

#[allow(dead_code)]
fn store_emergency(_state: &mut EcMasterState, slave_index: u16, error_code: u16, error_register: u8) {
    let mut guard = LAST_EMERGENCY.lock();
    *guard = Some(InternalEmergencyInfo {
        slave_index,
        error_code,
        error_register,
    });
}

// --- FFI Exports ---

#[no_mangle]
pub extern "C" fn ethercrab_version(buffer: *mut u8, len: usize) -> c_int {
    let version = env!("CARGO_PKG_VERSION");
    let version_bytes = version.as_bytes();
    if buffer.is_null() || len == 0 {
        return version_bytes.len() as c_int;
    }
    let to_copy = version_bytes.len().min(len);
    unsafe {
        std::ptr::copy_nonoverlapping(version_bytes.as_ptr(), buffer, to_copy);
    }
    to_copy as c_int
}

#[no_mangle]
pub extern "C" fn ethercrab_get_last_error(buffer: *mut u8, len: usize) -> c_int {
    if buffer.is_null() || len == 0 {
        return 0;
    }
    let guard = LAST_ERROR.lock();
    let error_bytes = guard.as_bytes();
    let to_copy = error_bytes.len().min(len);
    unsafe {
        std::ptr::copy_nonoverlapping(error_bytes.as_ptr(), buffer, to_copy);
    }
    to_copy as c_int
}

#[no_mangle]
pub extern "C" fn is_raw_socket_available() -> c_int {
    #[cfg(target_os = "linux")]
    unsafe {
        let fd = libc::socket(libc::AF_PACKET, libc::SOCK_RAW, 0);
        if fd >= 0 { 
            libc::close(fd); 
            return 1; 
        }
        return 0;
    }

    #[cfg(target_os = "macos")]
    unsafe {
        for i in 0..256 {
            let dev = format!("/dev/bpf{}\0", i);
            match libc::open(dev.as_ptr() as *const libc::c_char, libc::O_RDWR | libc::O_NONBLOCK) {
                -1 => continue,
                fd => {
                    libc::close(fd);
                    return 1;
                }
            }
        }
        return 0;
    }
    
    #[cfg(target_os = "windows")]
    {
        use pnet_datalink;
        let interfaces = pnet_datalink::interfaces();
        if interfaces.is_empty() { return 0; }
        if let Some(interface) = interfaces.first() {
             if let Ok(mut cap_builder) = pcap::Capture::from_device(interface.name.as_str()) {
                 if cap_builder.open().is_ok() { return 1; }
             }
        }
        return 0;
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    return 0;
}

#[no_mangle]
pub extern "C" fn ethercrab_init(
    interface: *const c_char,
    _expected_slaves: *const SlaveIdentity,
    _expected_count: usize,
    init_commands: *const FfiInitCommand,
    init_command_count: usize,
    pdu_timeout_ms: u64,
    state_transition_timeout_ms: u64,
    mailbox_response_timeout_ms: u64,
    eeprom_timeout_ms: u64,
    pdu_retries: usize,
) -> c_int {
    if interface.is_null() { return -1; }

    let interface_str = unsafe {
        match CStr::from_ptr(interface).to_str() {
            Ok(s) => s.to_string(),
            Err(e) => {
                set_error(format!("Invalid interface string: {}", e));
                return -2;
            }
        }
    };

    let cmds = if !init_commands.is_null() && init_command_count > 0 {
        unsafe { std::slice::from_raw_parts(init_commands, init_command_count).to_vec() }
    } else {
        Vec::new()
    };

    // Build custom Timeouts from parameters
    let timeouts = Timeouts {
        pdu: Duration::from_millis(pdu_timeout_ms),
        state_transition: Duration::from_millis(state_transition_timeout_ms),
        mailbox_response: Duration::from_millis(mailbox_response_timeout_ms),
        // Configurable eeprom timeout
        eeprom: Duration::from_millis(eeprom_timeout_ms),
        wait_loop_delay: Duration::from_millis(0),
        mailbox_echo: Duration::from_millis(100),
    };

    // Run purely on this thread. smol::block_on spins a local executor.
    let result = smol::block_on(async move {
        // Reset health status
        NETWORK_HEALTHY.store(true, Ordering::Relaxed);

        let maindevice = match GLOBAL_DEVICE.get() {
            Some(md) => md.clone(),
            None => {
                let (tx, rx, pdu_loop) = PDU_STORAGE.try_split().map_err(|_| {
                    set_error("Failed to split PDU storage - likely already in use");
                    -3
                })?;
                
                let maindevice = Arc::new(MainDevice::new(
                    pdu_loop,
                    timeouts,
                    MainDeviceConfig {
                        dc_static_sync_iterations: 0,  // Disable DC to avoid timeouts
                        retry_behaviour: ethercrab::RetryBehaviour::Count(pdu_retries),
                        ..MainDeviceConfig::default()
                    },
                ));

                // Spawn the network TX/RX task on a dedicated thread.
                let _md_clone = maindevice.clone();
                let iface = interface_str.clone();
                
                std::thread::Builder::new()
                    .name("ethercrab-tx-rx".into())
                    .stack_size(8 * 1024 * 1024)
                    .spawn(move || {
                        #[cfg(not(target_os = "windows"))]
                        {
                            // Use tx_rx_task which returns a future, block on it
                            let task = ethercrab::std::tx_rx_task(&iface, tx, rx).expect("Failed to create tx_rx task");
                            let _ = smol::block_on(task);
                        }
                        
                        #[cfg(target_os = "windows")]
                        {
                            // Use tx_rx_task_blocking for Windows
                            let _ = ethercrab::std::tx_rx_task_blocking(
                                &iface, tx, rx, ethercrab::std::TxRxTaskConfig { spinloop: false }
                            );
                        }
                    })
                    .map_err(|e| {
                        set_error(format!("Failed to spawn TX/RX thread: {}", e));
                        -3
                    })?;

                if GLOBAL_DEVICE.set(maindevice.clone()).is_err() {
                    set_error("Global device already initialized");
                    return Err(-3);
                }
                maindevice
            }
        };

        // Init Group
        let group = maindevice.init_single_group::<MAX_SUBDEVICES, MAX_PDI>(ethercat_now)
            .await.map_err(|e| {
                set_error(format!("Failed to init single group: {:?}", e));
                -5
            })?;


        // Run Init Commands
        for cmd in cmds {
            let slave_idx = cmd.slave_index as usize;
            if let Some(subdevice) = group.iter(&maindevice).nth(slave_idx) {
                let val = u32_from_bytes(cmd.value);
                if cmd.command_type == 0 {
                    let _ = subdevice.sdo_write(cmd.index, cmd.sub_index, val).await;
                } else {
                    let _ = subdevice.register_write(cmd.index, val).await;
                }
            }
        }

        let pdi_buffer = Arc::new(RwLock::new([0u8; MAX_PDI]));
        
        let master_state = EcMasterState {
            maindevice: maindevice.clone(),
            group: Some(GroupState::PreOp(group)),
            pdi_buffer,
            pdi_size: 0,
            input_size: 0,
            output_size: 0,
            expected_wkc: 0,
            mailbox_poll_interval_ms: None,
        };

    let mut guard = STATE.write();
        *guard = Some(master_state);
        Ok(0)
    });

    match result {
        Ok(v) => v,
        Err(e) => e,
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_verify_topology(
    expected: *const SlaveIdentity,
    expected_count: usize,
) -> c_int {
    if expected.is_null() || expected_count == 0 { return -1; }

    let expected_slaves = unsafe { std::slice::from_raw_parts(expected, expected_count) };
    
    // We need to access the group to iterate.
    // We can do this synchronously because we are just reading memory, not doing I/O.
    let guard = STATE.read();
    let state = match guard.as_ref() {
        Some(s) => s,
        None => return -1,
    };

    // Helper to get group count regardless of state
    let discovered_count = match &state.group {
        Some(GroupState::PreOp(g)) => g.len(),
        Some(GroupState::SafeOp(g)) => g.len(),
        Some(GroupState::Op(g)) => g.len(),
        None => return -1,
    };

    if discovered_count != expected_count { return -1; }

    for (idx, expected_slave) in expected_slaves.iter().enumerate() {
        let identity = match &state.group {
            Some(GroupState::PreOp(g)) => g.iter(&state.maindevice).nth(idx).map(|s| s.identity()),
            Some(GroupState::SafeOp(g)) => g.iter(&state.maindevice).nth(idx).map(|s| s.identity()),
            Some(GroupState::Op(g)) => g.iter(&state.maindevice).nth(idx).map(|s| s.identity()),
            None => return -1,
        };

        if let Some(id) = identity {
            if id.vendor_id != expected_slave.vendor_id || id.product_id != expected_slave.product_code {
                return -1;
            }
            if expected_slave.serial_number != 0 && id.serial != expected_slave.serial_number {
                return -1;
            }
        } else {
            return -1;
        }
    }

    0
}

#[no_mangle]
pub extern "C" fn ethercrab_request_state(target_state: u8) -> c_int {
    let mut guard = STATE.write();
    let state = match guard.as_mut() {
        Some(s) => s,
        None => return -1,
    };

    let group_enum = state.group.take(); 
    let maindevice = state.maindevice.clone();

    let result = smol::block_on(async {
        match (target_state, group_enum) {
            // Init (0) / PreOp (1) handled below

            
            // To SafeOp (2)
            (2, Some(GroupState::PreOp(g))) => {
                let g_safe = match g.into_safe_op(&maindevice).await {
                    Ok(g) => g,
                    Err(e) => {
                        set_error(format!("into_safe_op failed: {:?}", e));
                        return Err(-3);
                    }
                };
                
                let mut in_sz = 0;
                let mut out_sz = 0;
                for slave in g_safe.iter(&maindevice) {
                    let io = slave.io_raw();
                    in_sz += io.inputs().len();
                    out_sz += io.outputs().len();
                }
                
                // WKC counts all slaves in the group, not just those with PDI
                // This is because the LRW frame passes through all slaves
                let wkc_count = g_safe.len() as u16;
                
                Ok((Some(GroupState::SafeOp(g_safe)), in_sz, out_sz, wkc_count))
            },
            (2, Some(GroupState::SafeOp(g))) => Ok((Some(GroupState::SafeOp(g)), state.input_size, state.output_size, state.expected_wkc)),
            (2, Some(GroupState::Op(g))) => {
                // Op -> SafeOp
                let g_safe = match g.into_safe_op(&maindevice).await {
                    Ok(g) => g,
                    Err(e) => {
                        set_error(format!("into_safe_op failed: {:?}", e));
                        return Err(-3);
                    }
                };
                Ok((Some(GroupState::SafeOp(g_safe)), state.input_size, state.output_size, state.expected_wkc))
            },
            
            // To Op (3)
            (3, Some(GroupState::SafeOp(g))) => {
                let g_op = g.into_op(&maindevice).await.map_err(|e| {
                    set_error(format!("into_op failed: {:?}", e));
                    -3
                })?;
                Ok((Some(GroupState::Op(g_op)), state.input_size, state.output_size, state.expected_wkc))
            },
            (3, Some(GroupState::Op(g))) => Ok((Some(GroupState::Op(g)), state.input_size, state.output_size, state.expected_wkc)),
            
            // To PreOp (1) or Init (0)
            (0 | 1, Some(g_any)) => {
                 match g_any {
                     GroupState::PreOp(g) => Ok((Some(GroupState::PreOp(g)), 0, 0, 0)),
                     GroupState::SafeOp(g) => {
                        let g_pre = g.into_pre_op(&maindevice).await.map_err(|e| {
                            set_error(format!("into_pre_op failed: {:?}", e));
                            -3
                        })?;
                        Ok((Some(GroupState::PreOp(g_pre)), 0, 0, 0))
                     },
                     GroupState::Op(g) => {
                        // Op -> SafeOp -> PreOp
                        let g_safe = g.into_safe_op(&maindevice).await.map_err(|e| {
                            set_error(format!("into_safe_op failed: {:?}", e));
                            -3
                        })?;
                        let g_pre = g_safe.into_pre_op(&maindevice).await.map_err(|e| {
                            set_error(format!("into_pre_op failed: {:?}", e));
                            -3
                        })?;
                        Ok((Some(GroupState::PreOp(g_pre)), 0, 0, 0))
                     }
                 }
            },
            
            // Invalid Transitions
            (_, Some(g)) => Ok((Some(g), state.input_size, state.output_size, state.expected_wkc)), 

            (_, None) => {
                set_error("No group available for state transition");
                Err(-2)
            },
        }
    });

    match result {
        Ok((new_group, in_s, out_s, wkc)) => {
            state.group = new_group;
            state.input_size = in_s;
            state.output_size = out_s;
            state.pdi_size = in_s + out_s;
            state.expected_wkc = wkc;
            0
        },
        Err(e) => e
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_get_state() -> u8 {
    let guard = STATE.read();
    if let Some(state) = guard.as_ref() {
        match &state.group {
            Some(GroupState::PreOp(_)) => 1,
            Some(GroupState::SafeOp(_)) => 2,
            Some(GroupState::Op(_)) => 3,
            None => 0,
        }
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_get_al_status_code(slave_index: u16) -> u16 {
   
    let result = smol::block_on(async move {
        let guard = STATE.read();
        if let Some(ref master_state) = *guard {
            let maindevice = &master_state.maindevice;
            let idx = slave_index as usize;
            
            let status_result = match &master_state.group {
                Some(GroupState::PreOp(g)) => {
                    if let Some(subdevice) = g.iter(maindevice).nth(idx) {
                        subdevice.status().await
                    } else {
                        return Err(0);
                    }
                }
                Some(GroupState::SafeOp(g)) => {
                    if let Some(subdevice) = g.iter(maindevice).nth(idx) {
                        subdevice.status().await
                    } else {
                        return Err(0);
                    }
                }
                Some(GroupState::Op(g)) => {
                    if let Some(subdevice) = g.iter(maindevice).nth(idx) {
                        subdevice.status().await
                    } else {
                        return Err(0);
                    }
                }
                None => return Err(0),
            };
            
            match status_result {
                Ok((_, status_code)) => Ok(u16::from(status_code)),
                Err(_) => Err(0),
            }
        } else {
            Err(0)
        }
    });

    match result {
        Ok(code) => code,
        Err(_) => 0,
    }
}

/// Returns the PDI buffer pointer directly.
/// Note: Deno FFI doesn't correctly marshal pointers in struct returns, so we use separate functions.
#[no_mangle]
pub extern "C" fn ethercrab_get_pdi_buffer_ptr() -> *mut u8 {
    let guard = STATE.read();
    if let Some(state) = guard.as_ref() {
        let buf_guard = state.pdi_buffer.read();
        let ptr = buf_guard.as_ptr() as *mut u8;
        drop(buf_guard);
        ptr
    } else {
        std::ptr::null_mut()
    }
}

/// Returns total PDI size in bytes.
#[no_mangle]
pub extern "C" fn ethercrab_get_pdi_total_size() -> u32 {
    let guard = STATE.read();
    if let Some(state) = guard.as_ref() {
        state.pdi_size as u32
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_cyclic_tx_rx() -> c_int {
    let guard = STATE.read();
    let state = match guard.as_ref() {
        Some(s) => s,
        None => return -1,
    };

    // Fast path check
    let group = match &state.group {
        Some(GroupState::Op(g)) => g,
        _ => return -2,
    };

    let maindevice = &state.maindevice;

    // Sync Shared Memory -> EtherCrab SubDevice (before tx_rx)
    // Copy outputs from shared buffer to slaves so writes to pdi_buffer[0..output_size] are sent
    {
        let buffer = state.pdi_buffer.read(); // Read lock
        let mut offset = 0; // Outputs start at 0
        for slave in group.iter(maindevice) {
            let mut outs = slave.outputs_raw_mut();
            if outs.is_empty() { continue; }
            let len = outs.len();
            if offset + len <= buffer.len() {
                outs.copy_from_slice(&buffer[offset..offset+len]);
                offset += len;
            }
        }
    }

    // Perform IO (Blocking call on this thread)
    // We rely on ethercrab's internal PDU timeout configuration.
    // Lock contention from background tasks is handled by pausing them via NETWORK_HEALTHY flag.
    let wkc = match smol::block_on(group.tx_rx(maindevice)) {
        Ok(res) => {
            NETWORK_HEALTHY.store(true, Ordering::Relaxed);
            res.working_counter
        },
        Err(e) => {
            NETWORK_HEALTHY.store(false, Ordering::Relaxed);
            set_error(format!("Cyclic tx_rx failed: {:?}", e));
            return -2;
        },
    };
    // Copy Inputs (EtherCAT Frame -> Shared Memory)
    {
        let mut buffer = state.pdi_buffer.write();
        let mut offset = state.output_size;
        for slave in group.iter(maindevice) {
            let ins = slave.inputs_raw();
            if ins.is_empty() { continue; }
            let len = ins.len();
            if offset + len <= buffer.len() {
                buffer[offset..offset+len].copy_from_slice(&ins);
                offset += len;
            }
        }
    }

    // Note: WKC can vary depending on network topology and frame structure
    // Strict checking disabled - return actual WKC and let application decide
    wkc as c_int
}

#[no_mangle]
pub extern "C" fn ethercrab_sdo_read(
    slave_index: u16,
    index: u16,
    sub_index: u8,
    data_out: *mut u8,
    max_len: usize,
) -> c_int {
    if data_out.is_null() || max_len == 0 { return -4; }

    let guard = STATE.read();
    let state = match guard.as_ref() {
        Some(s) => s,
        None => return -1,
    };

    // We can only support small SDOs efficiently in this synchronous blocking manner
    if max_len > 4 { return -4; }

    let result = smol::block_on(async {
        let idx = slave_index as usize;
        
        // Generic helper to read
        async fn read_sdo(
            group: &GroupState, 
            md: &MainDevice<'_>, 
            idx: usize, 
            i: u16, 
            si: u8
        ) -> Result<[u8; 4], i32> {
            match group {
                GroupState::PreOp(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_read(i, si).await.map_err(|e| {
                    set_error(format!("SDO read failed: {:?}", e));
                    -3
                }),
                GroupState::SafeOp(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_read(i, si).await.map_err(|e| {
                     set_error(format!("SDO read failed: {:?}", e));
                    -3
                }),
                GroupState::Op(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_read(i, si).await.map_err(|e| {
                     set_error(format!("SDO read failed: {:?}", e));
                    -3
                }),
            }
        }

        read_sdo(state.group.as_ref().unwrap(), &state.maindevice, idx, index, sub_index).await
    });

    match result {
        Ok(data) => {
            let len = max_len.min(4);
            unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), data_out, len); }
            len as c_int
        },
        Err(e) => e,
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_sdo_write(
    slave_index: u16,
    index: u16,
    sub_index: u8,
    data: *const u8,
    len: usize,
) -> c_int {
    if data.is_null() || len == 0 || len > 4 { return -4; }
    
    let mut data_buf = [0u8; 4];
    unsafe { std::ptr::copy_nonoverlapping(data, data_buf.as_mut_ptr(), len); }

    let guard = STATE.read();
    let state = match guard.as_ref() {
        Some(s) => s,
        None => return -1,
    };

    let result = smol::block_on(async {
        let idx = slave_index as usize;
        let md = &state.maindevice;
        let g = state.group.as_ref().unwrap();
        
        match len {
            1 => match g {
                GroupState::PreOp(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, data_buf[0]).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
                GroupState::SafeOp(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, data_buf[0]).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
                GroupState::Op(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, data_buf[0]).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
            },
            2 => {
                let val = u16::from_le_bytes([data_buf[0], data_buf[1]]);
                match g {
                    GroupState::PreOp(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, val).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
                    GroupState::SafeOp(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, val).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
                    GroupState::Op(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, val).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
                }
            },
            4 => {
                let val = u32_from_bytes(data_buf);
                match g {
                    GroupState::PreOp(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, val).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
                    GroupState::SafeOp(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, val).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
                    GroupState::Op(g) => g.iter(md).nth(idx).ok_or(-2)?.sdo_write(index, sub_index, val).await.map_err(|e| { set_error(format!("SDO write failed: {:?}", e)); -3 }),
                }
            },
            _ => return Err(-4)
        }
    });

    match result {
        Ok(_) => 0,
        Err(e) => e,
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_eeprom_read(
    slave_index: u16,
    address: u16,
    data_out: *mut u8,
    len: usize,
) -> c_int {
    if data_out.is_null() || len == 0 { return -4; }

    let guard = STATE.read();
    let state = match guard.as_ref() {
        Some(s) => s,
        None => return -1,
    };

    let result = smol::block_on(async {
        let idx = slave_index as usize;
        let md = &state.maindevice;
        let mut buffer = vec![0u8; len];
        
        let read_res = match state.group.as_ref().unwrap() {
            GroupState::PreOp(g) => g.iter(md).nth(idx).ok_or(-2)?.eeprom_read_raw(md, address, &mut buffer).await,
            GroupState::SafeOp(g) => g.iter(md).nth(idx).ok_or(-2)?.eeprom_read_raw(md, address, &mut buffer).await,
            GroupState::Op(g) => g.iter(md).nth(idx).ok_or(-2)?.eeprom_read_raw(md, address, &mut buffer).await,
        };

        match read_res {
             Ok(bytes) => Ok((bytes, buffer)),
             Err(e) => {
                 set_error(format!("EEPROM read failed: {:?}", e));
                 Err(-3)
             }
        }
    });

    match result {
        Ok((bytes_read, buffer)) => {
            unsafe { std::ptr::copy_nonoverlapping(buffer.as_ptr(), data_out, bytes_read as usize); }
            bytes_read as c_int
        },
        Err(e) => e,
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_configure_mailbox_polling(interval_ms: u32) -> c_int {
    let mut guard = STATE.write();
    if let Some(state) = guard.as_mut() {
        if interval_ms == 0 {
            state.mailbox_poll_interval_ms = None;
        } else {
            state.mailbox_poll_interval_ms = Some(interval_ms);
        }
        0
    } else {
        -1
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_check_mailbox(slave_index: u16, mailbox_status_addr: u16) -> c_int {
    // If network is unhealthy, skip IO to avoid lock contention
    if !NETWORK_HEALTHY.load(Ordering::Relaxed) {
        return -1;
    }

    // We don't need manual timeouts here as PDU timeouts are handled by ethercrab

    let result = smol::block_on(async move {
        let guard = STATE.read();
        if let Some(ref master_state) = *guard {
                let maindevice = &master_state.maindevice;
                let idx = slave_index as usize;
                
                // Check we have a group
                if master_state.group.is_none() { return Err(-1); }
                
                let val_res = match master_state.group.as_ref().unwrap() {
                    GroupState::PreOp(g) => g.iter(maindevice).nth(idx).ok_or(-1)?.register_read::<u8>(mailbox_status_addr).await,
                    GroupState::SafeOp(g) => g.iter(maindevice).nth(idx).ok_or(-1)?.register_read::<u8>(mailbox_status_addr).await,
                    GroupState::Op(g) => g.iter(maindevice).nth(idx).ok_or(-1)?.register_read::<u8>(mailbox_status_addr).await,
                };
                
                match val_res {
                    Ok(val) => Ok(if (val & 0x08) != 0 { 1 } else { 0 }),
                    Err(_) => Err(-2)
                }
        } else {
            Err(-1)
        }
    });

    match result {
        Ok(v) => v,
        Err(e) => e,
    }
}

/// Feature 402: Mailbox Resilient Layer
/// Checks mailbox status with toggle-bit verification and retry mechanism
/// Returns: 0 (Empty), 1 (New Mail/Success), -1 (Error/State not ready), -2 (Retry Failed)
#[no_mangle]
pub extern "C" fn ethercrab_check_mailbox_resilient(
    slave_index: u16,
    mailbox_status_addr: u16,
    last_toggle_bit: u8, // 0 or 1. If > 1, ignore toggle check (first run)
) -> c_int {
    // If network is unhealthy, skip IO to avoid lock contention
    if !NETWORK_HEALTHY.load(Ordering::Relaxed) {
        return -1;
    }

    // Timeout is handled internally by ethercrab

    let result = smol::block_on(async move {
        let guard = STATE.read();
        if let Some(ref master_state) = *guard {
            let maindevice = &master_state.maindevice;
            let idx = slave_index as usize;

            // Check we have a group
            if master_state.group.is_none() {
                return Err(-1);
            }

            // Retry Loop (Resilient Layer) - max 3 attempts
            for _attempt in 0..3 {
                // 1. Read Register
                let val_res = match master_state.group.as_ref().unwrap() {
                    GroupState::PreOp(g) => {
                        g.iter(maindevice).nth(idx).ok_or(-1)?.register_read::<u8>(mailbox_status_addr).await
                    }
                    GroupState::SafeOp(g) => {
                        g.iter(maindevice).nth(idx).ok_or(-1)?.register_read::<u8>(mailbox_status_addr).await
                    }
                    GroupState::Op(g) => {
                        g.iter(maindevice).nth(idx).ok_or(-1)?.register_read::<u8>(mailbox_status_addr).await
                    }
                };

                match val_res {
                    Ok(val) => {
                        // Bit 3 = Mailbox Full (Input) (0x08)
                        // Bit 1 = Toggle Bit (Input) (0x02)
                        // Note: Check ETG.1000.4 spec for specific bit offsets per device

                        let mailbox_full = (val & 0x08) != 0;
                        let current_toggle = (val & 0x02) >> 1;

                        if !mailbox_full {
                            return Ok(0); // Empty
                        }

                        // If it's the first run (last_toggle_bit > 1), accept it.
                        // If toggle bit changed, accept it.
                        if last_toggle_bit > 1 || current_toggle != last_toggle_bit {
                            return Ok(1); // Success: New valid mail
                        }

                        // If we are here, Mailbox is full but Toggle Bit didn't change.
                        // This implies we might be re-reading an old frame or a lost update.
                        // Retry immediately.
                        continue;
                    }
                    Err(_) => continue, // Read failed, retry
                }
            }

            // Retries exhausted
            Err(-2)
        } else {
            Err(-1)
        }
    });

    match result {
        Ok(v) => v,
        Err(e) => e,
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_get_last_emergency(out: *mut EmergencyInfo) -> c_int {
    if out.is_null() { return -1; }

    let guard = LAST_EMERGENCY.lock();
    if let Some(ref emergency) = *guard {
        unsafe {
            (*out).slave_index = emergency.slave_index;
            (*out).error_code = emergency.error_code;
            (*out).error_register = emergency.error_register;
        }
        0
    } else {
        -1
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_write_process_data_byte(
    slave_index: u16,
    byte_offset: u32,
    value: u8,
) -> c_int {
    let result = smol::block_on(async {
        let mut guard = STATE.write();
        let state = match guard.as_mut() {
            Some(s) => s,
            None => return 0,
        };

        let group = match &mut state.group {
            Some(GroupState::Op(g)) => g,
            _ => return 0, // Not in OP state
        };

        let idx = slave_index as usize;
        if let Some(subdevice) = group.iter(&state.maindevice).nth(idx) {
            let mut outputs = subdevice.outputs_raw_mut();
            if let Some(byte) = outputs.get_mut(byte_offset as usize) {
                *byte = value;
                return 1;
            }
        }
        0
    });

    result
}

#[no_mangle]
pub extern "C" fn ethercrab_read_process_data_byte(
    slave_index: u16,
    byte_offset: u32,
    is_output: bool,
) -> u8 {
    let result = smol::block_on(async {
        let guard = STATE.read();
        let state = match guard.as_ref() {
            Some(s) => s,
            None => return 0,
        };

        let group = match &state.group {
            Some(GroupState::Op(g)) => g,
            _ => return 0, // Not in OP state
        };

        let idx = slave_index as usize;
        if let Some(subdevice) = group.iter(&state.maindevice).nth(idx) {
            let io = subdevice.io_raw();
            if is_output {
                if let Some(&byte) = io.outputs().get(byte_offset as usize) {
                    return byte;
                }
            } else {
                if let Some(&byte) = io.inputs().get(byte_offset as usize) {
                    return byte;
                }
            }
        }
        0
    });

    result
}

/// Read a 16-bit register value from a slave.
/// 
/// Common watchdog-related registers:
/// - 0x0400: Watchdog Divider (default ~2498, gives ~100µs per count)
/// - 0x0410: PDI Watchdog timeout
/// - 0x0420: SM Watchdog timeout (default ~1000 with default divider = ~100ms)
/// - 0x0440: SM Watchdog status
#[no_mangle]
pub extern "C" fn ethercrab_register_read_u16(
    slave_index: u16,
    register_address: u16,
) -> i32 {
    let result = smol::block_on(async move {
        let guard = STATE.read();
        let state = match guard.as_ref() {
            Some(s) => s,
            None => return Err(-1),
        };

        let idx = slave_index as usize;
        let md = &state.maindevice;
        
        let val_res = match state.group.as_ref() {
            Some(GroupState::PreOp(g)) => g.iter(md).nth(idx).ok_or(-2)?.register_read::<u16>(register_address).await,
            Some(GroupState::SafeOp(g)) => g.iter(md).nth(idx).ok_or(-2)?.register_read::<u16>(register_address).await,
            Some(GroupState::Op(g)) => g.iter(md).nth(idx).ok_or(-2)?.register_read::<u16>(register_address).await,
            None => return Err(-1),
        };
        
        match val_res {
            Ok(val) => Ok(val as i32),
            Err(e) => {
                set_error(format!("Register read failed: {:?}", e));
                Err(-3)
            }
        }
    });

    match result {
        Ok(v) => v,
        Err(e) => e,
    }
}

/// Write a 16-bit register value to a slave.
/// 
/// Common watchdog-related registers:
/// - 0x0400: Watchdog Divider
/// - 0x0410: PDI Watchdog timeout  
/// - 0x0420: SM Watchdog timeout
#[no_mangle]
pub extern "C" fn ethercrab_register_write_u16(
    slave_index: u16,
    register_address: u16,
    value: u16,
) -> i32 {
    let result = smol::block_on(async move {
        let guard = STATE.read();
        let state = match guard.as_ref() {
            Some(s) => s,
            None => return Err(-1),
        };

        let idx = slave_index as usize;
        let md = &state.maindevice;
        
        let write_res = match state.group.as_ref() {
            Some(GroupState::PreOp(g)) => g.iter(md).nth(idx).ok_or(-2)?.register_write(register_address, value).await,
            Some(GroupState::SafeOp(g)) => g.iter(md).nth(idx).ok_or(-2)?.register_write(register_address, value).await,
            Some(GroupState::Op(g)) => g.iter(md).nth(idx).ok_or(-2)?.register_write(register_address, value).await,
            None => return Err(-1),
        };
        
        match write_res {
            Ok(_) => Ok(0),
            Err(e) => {
                set_error(format!("Register write failed: {:?}", e));
                Err(-3)
            }
        }
    });

    match result {
        Ok(v) => v,
        Err(e) => e,
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_destroy() {
    *STATE.write() = None;
    *LAST_EMERGENCY.lock() = None;
}
// --- Discovery FFI ---

#[repr(C)]
#[derive(Clone, Copy)]
pub struct FfiSlaveInfo {
    pub identity: SlaveIdentity,
    pub name: [u8; 64],
    pub configured_address: u16,
    pub alias_address: u16,
    pub port_count: u8,
    pub _padding: [u8; 1],
    pub mailbox_protocols: u16, // Bitmask: 0x01=CoE, 0x02=FoE, 0x04=EoE, 0x08=SoE
    pub dc_supported: u8,       // 0=false, 1=true
    pub _padding2: [u8; 1],     // Padding for alignment
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct FfiPdoInfo {
    pub index: u16,
    pub num_entries: u8,
    pub sync_manager: u8, // 2 = Rx/Output, 3 = Tx/Input
    pub name: [u8; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct FfiPdoEntryInfo {
    pub index: u16,
    pub sub_index: u8,
    pub bit_len: u8,
    pub data_type: u16,
    pub name: [u8; 64],
}

pub struct DiscoveredEntry {
    pub info: FfiPdoEntryInfo,
}

pub struct DiscoveredPdo {
    pub info: FfiPdoInfo,
    pub entries: Vec<DiscoveredEntry>,
}

pub struct DiscoveredSlave {
    pub info: FfiSlaveInfo,
    pub pdos: Vec<DiscoveredPdo>,
}

pub struct ScanContext {
    pub slaves: Vec<DiscoveredSlave>,
}

fn string_to_fixed_bytes(s: &str, out: &mut [u8; 64]) {
    let bytes = s.as_bytes();
    let len = bytes.len().min(63);
    out[..len].copy_from_slice(&bytes[..len]);
    out[len] = 0;
}

// Static PDU storage for the scanner (separate from the main master)
// We need this because PduStorage::new() is const, but we want a fresh one for the scanner
// However, PduStorage cannot be easily created on stack and passed around if we want to be static?
// Actually, we can create it on the stack inside the scan function if we don't need it to outlive the scan.
// But PduStorage needs to be split, and the split parts live in the future.
// We can allocate it on the heap? `Box::new(PduStorage::new())`? PduStorage might be large.
// ethercrab::PduStorage is generic over N and size.
// Let's just use a static Mutex for the scan lock to prevent concurrent scans if we use a static storage?
// Or better: Allocate it on the heap.
// Note: `PduStorage` creates a `PduLoop` which has a lifetime.
// The `MainDevice` takes the `PduLoop`.
// We'll try to do it all inside the async block.

async fn perform_scan(maindevice: &MainDevice<'_>) -> Result<Vec<DiscoveredSlave>, i32> {
    let group = maindevice.init_single_group::<MAX_SUBDEVICES, MAX_PDI>(ethercat_now)
        .await.map_err(|e| {
            set_error(format!("Scan init_single_group failed: {:?}", e));
            -2
        })?;

    let mut discovered_slaves = Vec::new();

    for subdevice in group.iter(maindevice) {
        let identity = subdevice.identity();
        let name_str = subdevice.name();
        
        let mut name = [0u8; 64];
        string_to_fixed_bytes(name_str, &mut name);
        
        // Detect capabilities
        let mut mailbox_protocols = 0u16;
        let mut dc_supported = 0u8;

        let mut pdos = Vec::new();
        
        // Scan SM2 (Outputs/RxPDO, sync_manager=2) and SM3 (Inputs/TxPDO, sync_manager=3)
        // Note: Not all slaves have 0x1C12/0x1C13 (e.g., EK1100 couplers), so we skip them gracefully
        let sm_configs = [
            (0x1C12, 2), // RxPDO
            (0x1C13, 3), // TxPDO
        ];

        for (sm_idx, sm_num) in sm_configs {
            // Skip if slave doesn't have this SM assignment object
            if let Ok(count) = subdevice.sdo_read::<u8>(sm_idx, 0).await {
                if count == 0 {
                    continue;
                }
                // If we successfully read SDOs, CoE is supported
                mailbox_protocols |= 0x01; // CoE flag
                for i in 1..=count {
                    if let Ok(pdo_index) = subdevice.sdo_read::<u16>(sm_idx, i).await {
                        let pdo_name = [0u8; 64];
                        
                        let mut entries = Vec::new();
                        
                        if let Ok(entry_count) = subdevice.sdo_read::<u8>(pdo_index, 0).await {
                            for j in 1..=entry_count {
                                if let Ok(mapping) = subdevice.sdo_read::<u32>(pdo_index, j).await {
                                    let target_idx = (mapping >> 16) as u16;
                                    let target_sub = ((mapping >> 8) & 0xFF) as u8;
                                    let bit_len = (mapping & 0xFF) as u8;
                                    
                                    let mut entry_name = [0u8; 64];
                                    let mut data_type = 0u16;
                                    
                                    // Generate a name if we can't get one
                                    if entry_name[0] == 0 {
                                        let name_str = format!("Entry_0x{:04x}_{:02x}", target_idx, target_sub);
                                        string_to_fixed_bytes(&name_str, &mut entry_name);
                                    }
                                    
                                    // Guess type from bit_len
                                    if data_type == 0 {
                                        data_type = match bit_len {
                                            1 => 0x0001,
                                            8 => 0x0005,
                                            16 => 0x0006,
                                            32 => 0x0007,
                                            64 => 0x0015, // INT64/UINT64
                                            _ => 0x0000, // Unknown
                                        };
                                    }

                                    entries.push(DiscoveredEntry {
                                        info: FfiPdoEntryInfo {
                                            index: target_idx,
                                            sub_index: target_sub,
                                            bit_len,
                                            data_type,
                                            name: entry_name,
                                        }
                                    });
                                }
                            }
                        }

                        pdos.push(DiscoveredPdo {
                            info: FfiPdoInfo {
                                index: pdo_index,
                                num_entries: entries.len() as u8,
                                sync_manager: sm_num,
                                name: pdo_name,
                            },
                            entries,
                        });
                    }
                }
            }
        }
        
        // If no CoE PDOs were found, try reading from EEPROM
        if pdos.is_empty() {
            // Read TxPDO (Inputs from device perspective = SM3)
            if let Ok(eeprom_tx_pdos) = subdevice.eeprom().maindevice_read_pdos().await {
                for (pdo_idx, pdo) in eeprom_tx_pdos.iter().enumerate() {
                    // EEPROM PDOs provide total bit_len but not individual entry details
                    // Create a single entry representing the whole PDO
                    let mut entry_name = [0u8; 64];
                    let name_str = format!("Input_PDO_{}", pdo_idx);
                    string_to_fixed_bytes(&name_str, &mut entry_name);
                    
                    let data_type = match pdo.bit_len {
                        1 => 0x0001,  // BOOL
                        8 => 0x0005,  // UINT8
                        16 => 0x0006, // UINT16
                        32 => 0x0007, // UINT32
                        _ if pdo.bit_len <= 8 => 0x0005,   // UINT8
                        _ if pdo.bit_len <= 16 => 0x0006,  // UINT16
                        _ if pdo.bit_len <= 32 => 0x0007,  // UINT32
                        _ => 0x0000,
                    };
                    
                    let entries = vec![DiscoveredEntry {
                        info: FfiPdoEntryInfo {
                            index: 0x6000 + pdo_idx as u16,  // Synthetic index
                            sub_index: 0,
                            bit_len: pdo.bit_len as u8,
                            data_type,
                            name: entry_name,
                        }
                    }];
                    
                    pdos.push(DiscoveredPdo {
                        info: FfiPdoInfo {
                            index: 0x1A00 + pdo_idx as u16,  // Synthetic TxPDO index
                            num_entries: 1,
                            sync_manager: 3,  // TxPDO = inputs = SM3 (canonical number)
                            name: [0u8; 64],
                        },
                        entries,
                    });
                }
            }
            
            // Read RxPDO (Outputs from device perspective = SM2)
            if let Ok(eeprom_rx_pdos) = subdevice.eeprom().maindevice_write_pdos().await {
                for (pdo_idx, pdo) in eeprom_rx_pdos.iter().enumerate() {
                    let mut entry_name = [0u8; 64];
                    let name_str = format!("Output_PDO_{}", pdo_idx);
                    string_to_fixed_bytes(&name_str, &mut entry_name);
                    
                    let data_type = match pdo.bit_len {
                        1 => 0x0001,  // BOOL
                        8 => 0x0005,  // UINT8
                        16 => 0x0006, // UINT16
                        32 => 0x0007, // UINT32
                        _ if pdo.bit_len <= 8 => 0x0005,   // UINT8
                        _ if pdo.bit_len <= 16 => 0x0006,  // UINT16
                        _ if pdo.bit_len <= 32 => 0x0007,  // UINT32
                        _ => 0x0000,
                    };
                    
                    let entries = vec![DiscoveredEntry {
                        info: FfiPdoEntryInfo {
                            index: 0x7000 + pdo_idx as u16,  // Synthetic index
                            sub_index: 0,
                            bit_len: pdo.bit_len as u8,
                            data_type,
                            name: entry_name,
                        }
                    }];
                    
                    pdos.push(DiscoveredPdo {
                        info: FfiPdoInfo {
                            index: 0x1600 + pdo_idx as u16,  // Synthetic RxPDO index
                            num_entries: 1,
                            sync_manager: 2,  // RxPDO = outputs = SM2 (canonical number)
                            name: [0u8; 64],
                        },
                        entries,
                    });
                }
            }
        }
        
        // Check DC support by attempting to read DC System Time register (0x0910)
        // If the read succeeds, the device supports DC. If it fails, we assume no DC support.
        // This is a non-blocking check - errors are ignored to avoid interrupting the scan.
        let _ = subdevice.register_read::<u32>(0x0910u16).await.map(|_| {
            dc_supported = 1;
        });
        
        let slave_info = FfiSlaveInfo {
            identity: SlaveIdentity {
                vendor_id: identity.vendor_id,
                product_code: identity.product_id,
                revision: identity.revision,
                serial_number: identity.serial,
            },
            name,
            configured_address: subdevice.configured_address(),
            alias_address: subdevice.alias_address(),
            port_count: 0, // TODO: Get port count if possible
            _padding: [0],
            mailbox_protocols,
            dc_supported,
            _padding2: [0],
        };
        
        discovered_slaves.push(DiscoveredSlave {
            info: slave_info,
            pdos,
        });
    }
    
    Ok(discovered_slaves)
}

#[no_mangle]
pub extern "C" fn ethercrab_scan_new(interface: *const c_char) -> *mut ScanContext {
    if interface.is_null() { return std::ptr::null_mut(); }

    // Check global state lock to avoid hardware resource conflict
    if STATE.read().is_some() {
        return std::ptr::null_mut();
    }

    let interface_str = unsafe {
        match CStr::from_ptr(interface).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return std::ptr::null_mut(),
        }
    };

    // We use a separate PDU storage for scanning to avoid conflict with global STATE
    // MAX_FRAMES=16, MAX_PDU_DATA=1100 -> ~17KB. Safe for stack or heap.
    
    let result: Result<*mut ScanContext, i32> = smol::block_on(async move {
        #[cfg(not(target_os = "windows"))]
        {
            // On macOS/Linux we can use future::race to clean up the task.
            // Storage is stack allocated (Boxed) and dropped after race.
            let storage = Box::new(PduStorage::<16, 1100>::new());
            let (tx, rx, pdu_loop) = storage.try_split().map_err(|_| {
                set_error("Scan storage split failed");
                -1
            })?;
            
            let maindevice = MainDevice::new(
                pdu_loop,
                Timeouts::default(),
                MainDeviceConfig {
                    dc_static_sync_iterations: 0,  // Disable DC
                    ..MainDeviceConfig::default()
                },
            );
            
            let iface = interface_str.clone();
            
            // Task 1: Network Loop
            let network_fut = async {
                let _ = ethercrab::std::tx_rx_task(&iface, tx, rx).expect("Scan TX/RX").await;
                // Should not return unless error or cancelled
                set_error("Scan network task ended unexpectedly");
                Err(-1) 
            };

            // Task 2: Scan Logic
            let scan_fut = async {
                let slaves = perform_scan(&maindevice).await?;
                Ok(Box::into_raw(Box::new(ScanContext { slaves })))
            };
            
            // Race them. When scan_fut completes, network_fut is dropped.
            future::race(scan_fut, network_fut).await
        }

        #[cfg(target_os = "windows")]
        {
            // On Windows, we stick to the leak model for now due to threading constraints
            // (tx_rx_task_blocking requires blocking thread)
            let storage = Box::leak(Box::new(PduStorage::<16, 1100>::new()));
            let (tx, rx, pdu_loop) = storage.try_split().map_err(|_| {
                set_error("Scan storage split failed");
                -1
            })?;
            
            let maindevice = MainDevice::new(
                pdu_loop,
                Timeouts::default(),
                MainDeviceConfig {
                    dc_static_sync_iterations: 0,  // Disable DC
                    ..MainDeviceConfig::default()
                },
            );
            
            let iface = interface_str.clone();
             std::thread::spawn(move || {
                 let _ = ethercrab::std::tx_rx_task_blocking(&iface, tx, rx, ethercrab::std::TxRxTaskConfig { spinloop: false });
             });

            let slaves = perform_scan(&maindevice).await?;
            Ok(Box::into_raw(Box::new(ScanContext { slaves })))
        }
    });

    match result {
        Ok(ptr) => ptr,
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_scan_get_slave_count(ctx: *const ScanContext) -> u32 {
    if ctx.is_null() { return 0; }
    unsafe { (*ctx).slaves.len() as u32 }
}

#[no_mangle]
pub extern "C" fn ethercrab_scan_get_slave(ctx: *const ScanContext, idx: u32, out_info: *mut FfiSlaveInfo) -> c_int {
    if ctx.is_null() || out_info.is_null() { return -1; }
    unsafe {
        if let Some(slave) = (&(*ctx).slaves).get(idx as usize) {
            *out_info = slave.info;
            0
        } else {
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_scan_get_pdo_count(ctx: *const ScanContext, slave_idx: u32) -> u32 {
    if ctx.is_null() { return 0; }
    unsafe {
        if let Some(slave) = (&(*ctx).slaves).get(slave_idx as usize) {
            slave.pdos.len() as u32
        } else {
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_scan_get_pdo(
    ctx: *const ScanContext, 
    slave_idx: u32, 
    pdo_pos: u32, 
    out_info: *mut FfiPdoInfo
) -> c_int {
    if ctx.is_null() || out_info.is_null() { return -1; }
    unsafe {
        if let Some(slave) = (&(*ctx).slaves).get(slave_idx as usize) {
            if let Some(pdo) = slave.pdos.get(pdo_pos as usize) {
                *out_info = pdo.info;
                0
            } else {
                -1
            }
        } else {
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_scan_get_pdo_entry_count(
    ctx: *const ScanContext, 
    slave_idx: u32, 
    pdo_pos: u32
) -> u32 {
    if ctx.is_null() { return 0; }
    unsafe {
        if let Some(slave) = (&(*ctx).slaves).get(slave_idx as usize) {
            if let Some(pdo) = slave.pdos.get(pdo_pos as usize) {
                return pdo.entries.len() as u32;
            }
        }
        0
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_scan_get_pdo_entry(
    ctx: *const ScanContext, 
    slave_idx: u32, 
    pdo_pos: u32, 
    entry_pos: u32, 
    out_info: *mut FfiPdoEntryInfo
) -> c_int {
    if ctx.is_null() || out_info.is_null() { return -1; }
    unsafe {
        if let Some(slave) = (&(*ctx).slaves).get(slave_idx as usize) {
            if let Some(pdo) = slave.pdos.get(pdo_pos as usize) {
                if let Some(entry) = pdo.entries.get(entry_pos as usize) {
                    *out_info = entry.info;
                    0
                } else {
                    -1
                }
            } else {
                -1
            }
        } else {
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn ethercrab_scan_free(ctx: *mut ScanContext) {
    if !ctx.is_null() {
        unsafe {
            let _ = Box::from_raw(ctx);
        }
    }
}

