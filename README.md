# Deno EtherCAT Wrapper

A TypeScript/Deno wrapper for the
[ethercrab](https://github.com/ethercrab-rs/ethercrab) Rust library, providing a
Class B EtherCAT Master implementation. A high-performance Rust FFI wrapper for
the `ethercrab` EtherCAT master crate, designed for integration with Deno or
Node.js runtimes.

## Installation

```bash
deno add jsr:@controlx-io/jn-ec-master
# the binaries are NOT included in the packaged
# run the following command to download it to ./lib-jn-ec-master
deno run --allow-run --allow-net --allow-write --allow-read jsr:@controlx-io/jn-ec-master/scripts/download-binaries
```

## Target Applications

This library is designed to use for **Discrete Automation**, **Process Control**, and the majority of **General Industrial Automation** applications.

### What Amount of Applications Require This Speed?

While marketing materials often hype "microsecond speeds," the reality of the industrial install base is quite different.

| Application Tier                  | Strict Determinism?     | To use? | Examples                                                          |
| :-------------------------------- | :---------------------- | :-----: | :---------------------------------------------------------------- |
| **Tier 1: Industrial & Building** | **VERY LOW** (>500 ms)  |   ✅    | Lighting control, Energy monitoring, HVAC status, Access control. |
| **Tier 2: Process Control**       | **LOW** (>50 ms)        |   ✅    | Water treatment, HVAC, Chemical mixing, Oil & Gas monitoring.     |
| **Tier 3: Discrete Automation**   | **IMPORTANT** (5–20 ms) |   🟠    | Bottling lines, Conveyors, Assembly stations, Palletizing.        |
| **Tier 4: Motion & Safety**       | **CRITICAL** (<1 ms)    |   ❌    | Robotics, CNC, High-speed packaging, Printing, Optical sorting.   |

**Summary:** Only about **15–20%** of industrial applications (Tier 1) strictly _require_ hard real-time determinism where a 10 ms drift would cause failure. The vast majority (~80%) would continue to run with a 15 ms drift, though Tier 2 applications might suffer from reduced efficiency or throughput.

**WHILE IT IS PRODUCTION READY, DO YOUR RESEARCH BEFORE USING THIS PACKAGE**

## Pre-compiled Binaries

The Rust FFI library is pre-compiled for the following targets and bundled with
this package:

- `linuxA64`: `aarch64-unknown-linux-gnu`
- `linux64`: `x86_64-unknown-linux-gnu`
- `win64`: `x86_64-pc-windows-msvc`
- `mac64`: `x86_64-apple-darwin`
- `macA64`: `aarch64-apple-darwin`

## Platform Requirements

### Linux

Requires `CAP_NET_RAW` capability or root privileges for raw socket access.

### macOS

Works without special privileges. Uses BPF devices for raw packet access.

### Windows

Requires **Npcap** or **WinPcap** driver installed with "WinPcap compatibility
mode" enabled. Download from
[https://npcap.com/#download](https://npcap.com/#download)

## Status

**Phase 5.7 Complete:** Full TypeScript API implemented. The wrapper now
supports:

- **Non-blocking I/O:** All network operations are async, suitable for
  event-driven architectures (Deno).
- **Feature 104:** State machine control (Init -> Op).
- **Feature 201:** High-performance cyclic operations with zero-copy shared
  memory.
- **Feature 302:** Topology verification against ENI (VendorID, ProductCode).
- **Feature 402:** Mailbox Resilient Layer (Toggle-bit verification & Retries).
- **Feature 404:** Mailbox polling with dynamic register support.
- **Feature 501:** CoE (SDO Read/Write).
- **Feature 505:** CoE Emergency Message handling with automatic listeners.
- **Feature 305:** SII (EEPROM Read).

## Usage

### Basic Example

```typescript
import { EcMaster, SlaveState } from "jsr:@controlx-io/jn-ec-master";
import { createCycleLoop } from "jsr:@controlx-io/jn-ec-master/cycle-loop";

// Discover network or load ENI config
const config = await EcMaster.discoverNetwork("eth0");
// Or load from file: const config = await loadEniFromXml("config.xml");

// Initialize master and transition to OP state
const master = new EcMaster(config);
await master.initialize();
await master.requestState(SlaveState.INIT);
await master.requestState(SlaveState.PRE_OP);
await master.requestState(SlaveState.SAFE_OP);
await master.requestState(SlaveState.OP);

// Get mappings to access process variables
const mappings = master.getMappings();
const inputVar = Array.from(mappings.values()).find((m) => m.isInput);
const outputVar = Array.from(mappings.values()).find((m) => !m.isInput);

// Create cycle loop
const cycleController = createCycleLoop({
  cycleTimeUs: config.master.cycleTime || 10000,
  cycleFn: async () => {
    const wkc = await master.runCycle();

    // Read input using mapping
    if (inputVar) {
      const inputValue = inputVar.currentValue;
      console.log(`Input: ${inputValue}`);

      // Write output using mapping
      if (outputVar) {
        outputVar.newValue = inputValue;
      }
    }

    return wkc;
  },
});

cycleController.start();
```

### APIs

#### Discovery

```typescript
// Discover network and generate ENI config
const config = await EcMaster.discoverNetwork("eth0");
```

#### Reading and Writing Process Data

There are three approaches for reading inputs and writing outputs:

**1. Using Variable Mappings (Recommended for named variables)**

```typescript
const mappings = master.getMappings();
const inputMapping = mappings.get("Slave1.Input_Voltage");
const outputMapping = mappings.get("Slave1.Output_Command");

// Read input value
if (inputMapping) {
  const value = inputMapping.currentValue;
  console.log(`Input: ${value}`);
}

// Write output value
if (outputMapping) {
  outputMapping.newValue = 42;
}
```

**2. Using Shared Buffer (Bulk operations)**

```typescript
// Get the shared process data buffer
const buffer = master.getProcessDataBuffer();
const mappings = master.getMappings();

// Read input using byte offset from mapping
const inputMapping = mappings.get("Slave1.Input_Voltage");
if (inputMapping) {
  const byteVal = buffer[inputMapping.pdiByteOffset];
  const bitVal = ((byteVal >> (inputMapping.bitOffset ?? 0)) & 1) === 1;
  console.log(`Input: ${bitVal}`);
}

// Write output using byte offset
const outputMapping = mappings.get("Slave1.Output_Command");
if (outputMapping) {
  const byteOffset = outputMapping.pdiByteOffset;
  const bitOffset = outputMapping.bitOffset ?? 0;
  const byteVal = buffer[byteOffset] ?? 0;
  buffer[byteOffset] = (byteVal & ~(1 << bitOffset)) | ((1 ? 1 : 0) << bitOffset);
}
```

**3. Direct PDO Byte Access (Per-slave operations)**

```typescript
// Write a byte to slave's output (slave index, byte offset, value)
master.writePdoByte(1, 0, 0xFF);

// Read a byte from slave's input
const inputValue = master.readPdoByte(1, 0, false);

// Read a byte from slave's output (to verify a write)
const outputValue = master.readPdoByte(1, 0, true);
```

**Summary:**

- **Variable Mappings**: Use `getMappings()` to access named variables with `currentValue` and `newValue` properties. Best for high-level application logic.
- **Shared Buffer**: Use `getProcessDataBuffer()` for bulk reading of all inputs at once. The buffer is automatically updated after each `runCycle()` call.
- **Direct PDO Access**: Use `writePdoByte()` and `readPdoByte()` for per-slave byte-level operations. Fastest method for direct hardware control.

### Examples

Run the examples as following:

**Linux/macOS:**

```bash
# Discover and save ENI config
deno -A --unstable-ffi examples/discover.ts discovered.json eth0

# to read ENI config
# deno run -A --unstable-ffi examples/cycle_eni_config.ts <path-to-eni-xml-or-json> [interface] [--fast]
deno run -A --unstable-ffi examples/cycle_eni_config.ts discovered.json eth0
# Use --fast flag to override cycleTime to 1ms (ignores config cycleTime)
deno run -A --unstable-ffi examples/cycle_eni_config.ts discovered.json eth0 --fast

# Combined: Discover, create ENI config and Cycle FAST
IF=eth0 deno task example:cycle

# 3 phases: Discover, Configure , Cycle
deno -A --unstable-ffi examples/three_phase_check.ts eth0
```

**Windows:**

```powershell
# First, find your interface name (e.g., "Ethernet 1" or "Wi-Fi")
Get-NetAdapter | Select-Object Name

# Discover and save ENI config (use your actual interface name)
deno -A --unstable-ffi examples/discover.ts discovered.json "Ethernet 1"

# Cycle with ENI config
deno run -A --unstable-ffi examples/cycle_eni_config.ts discovered.json "Ethernet 1"
deno run -A --unstable-ffi examples/cycle_eni_config.ts discovered.json "Ethernet 1" --fast

# 3 phases: Discover, Configure , Cycle
deno -A --unstable-ffi examples/three_phase_check.ts "Ethernet 1"
```

## Development

### Building the Rust FFI

1. Ensure you have Rust installed (`rustup`).
2. Ensure you have Deno installed.
3. Build the FFI library:

```bash
git clone https://github.com/alex-controlx/ethercrab.git
deno task build
# add Linux permissions for development
sudo setcap 'cap_net_raw,cap_net_admin=eip' $(which deno)
```

### Running Tests

**Rust Integration Tests:** Run tests for the FFI layer (requires hardware
simulation or specific environment setup):

```bash
deno task test:rust

# Specifying am interface (using env var)
IF=eth0 deno task test:hardware
```

_Note: Tests use `serial_test` to run sequentially as they share a global
singleton._

**Deno Tests:** Run TypeScript wrapper tests:

```bash
deno task test:ts
# or all including rust
deno task test
```

### Building Release Binaries (CI/CD)

To build and release the FFI binaries for all platforms using GitHub Actions:

1. **Automatic (Recommended):**
   Push a version tag (e.g., `v1.0.0`) to trigger the build and create a GitHub Release.
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **Manual:**
   Go to **Actions** → **Build and Bundle Binaries** → **Run workflow**.
   You can optionally provide a version tag (e.g., `v1.0.0`).

The workflow produces a `bundled-binaries` artifact and a GitHub Release with the compiled libraries for macOS, Linux, and Windows.

## Usage Pattern: The Connector Model

This library is designed to function as an independent **EtherCAT Connector**.
It is intended to run in a dedicated polling loop (separate from the main
application logic) that synchronizes data between the physical hardware and a
shared memory buffer.

The workflow relies on **Zero-Copy Shared Memory**:

1. **Initialization:** The host (JS/TS) initializes the master and retrieves a
   pointer to the Process Data Image (PDI).
2. **Memory Mapping:** The host creates a view (e.g., `Uint8Array`) directly
   over this memory pointer.
3. **Cyclic Polling:** The host runs an asynchronous loop that calls
   `ethercrab_cyclic_tx_rx`.
   - Rust handles the network transmission and updates the PDI buffer.
   - The host application reads/writes inputs and outputs directly from the
     shared memory view.
4. **Logic Decoupling:** Because the memory is shared, the main application
   logic does not need to wait for the EtherCAT cycle; it simply reads the
   latest snapshot from the memory buffer.

## API Strategy: Async vs. Blocking

The FFI exports are categorized based on whether they involve **Physical I/O**
or **Memory Access**.

### 1. Asynchronous APIs (`nonblocking: true`)

**Examples:** `ethercrab_cyclic_tx_rx`, `ethercrab_init`, `ethercrab_sdo_write`

- **Purpose:** These functions perform physical network operations
  (sending/receiving packets over raw sockets).
- **Why Async:** Network I/O is non-deterministic and slow relative to CPU
  speeds (microseconds to milliseconds). Using non-blocking FFI ensures the main
  runtime's event loop remains responsive while the Rust thread handles the wire
  transmission and waits for packet returns.

### 2. Synchronous APIs (`nonblocking: false`)

**Examples:** `ethercrab_get_process_data_info`, `ethercrab_get_state`

- **Purpose:** These functions retrieve status information or memory pointers
  that are already present in the library's allocated RAM.
- **Why Blocking:** Reading a variable from memory takes nanoseconds. The
  overhead of scheduling an asynchronous Promise (serializing arguments, context
  switching threads) is significantly higher than the execution time of the
  function itself. Making these calls synchronous provides the lowest possible
  latency.

## Internal Architecture & Optimization

The Rust implementation utilizes **Direct Execution** combined with
`parking_lot` synchronization to achieve "Soft Real-Time" suitability.

### The `parking_lot` Optimization

Instead of using standard library mutexes or complex message-passing channels,
the library uses `parking_lot::Mutex`.

- **Micro-Latency:** `parking_lot` mutexes are significantly faster and smaller
  than `std::sync::Mutex`. In the uncontended case (which is typical for a
  well-structured polling loop), locking is effectively a few CPU instructions,
  avoiding expensive operating system syscalls.
- **Direct Execution:** By removing the global executor channel (Actor pattern),
  the library avoids the overhead of allocating tasks, sending messages across
  threads, and waiting for responses. When the FFI function is called, it
  executes the logic immediately on the calling thread.
- **Thread Safety:** This synchronization primitive ensures that the cyclic
  polling loop and any concurrent acyclic requests (like SDO writes or status
  checks) can safely access the global master state without race conditions or
  deadlocks.

## Compliance & Architecture

This library targets **EtherCAT Master Class B** compliance (ETG.1500).

- [Class B Compliance Matrix](docs/compliance/CLASS_B_MATRIX.md) - Detailed feature verification.
- [Discovery Mode Specification](docs/compliance/DISCOVERY_MODE_SPEC.md) - Logic for network scanning.
- [ENI Parser Specification](docs/compliance/ENI_PARSER_SPEC.md) - XML parsing and topology validation rules.

## ⚠️ Disclaimer

**This library is currently experimental and has not yet passed the ETG
Conformance Test, unless explicitly stated in release branches. The main branch
is considered as development and no ETG Conformance Test has been done.**

## ⚖️ Legal & Trademark Notice

### EtherCAT® Technology

**EtherCAT® is a registered trademark and patented technology, licensed by
Beckhoff Automation GmbH, Germany.**

This project serves as an open-source implementation (wrapper) of the EtherCAT
Master functionality. It is **not** an official product of the EtherCAT
Technology Group (ETG) or Beckhoff Automation GmbH.

### Conformance & Certification

**Usage of this software does not automatically guarantee compliance with the
EtherCAT protocol specifications.**

- **For Developers:** This library is designed to assist in creating
  EtherCAT-compatible devices. However, the final application or device must
  still undergo independent validation.
- **For Commercial Distribution:** If you intend to sell, deliver, or distribute
  a product based on this stack, you are required to:
  1. Join the EtherCAT Technology Group (ETG).
  2. Obtain a valid **EtherCAT Vendor ID**.
  3. Pass the official **EtherCAT Conformance Test** (CTT) to ensure
     compatibility.

### License & Warranty

This software is provided "AS IS", without warranty of any kind. Specifically,
no warranty is given regarding the suitability for any specific or intended use.
The authors and contributors assume no liability for loss or damage sustained
through the use of this information or code.

**Note on Safety:** This software is **not** intended for use in functional
safety applications (e.g., SIL 3/4) unless used in conjunction with certified
safety hardware (FSoE) and validated by a relevant authority.
