# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TypeScript/Deno FFI wrapper around the `ethercrab` Rust library, implementing an EtherCAT Master Class B (ETG.1500). Published as `@controlx-io/jn-ec-master` on JSR.

## Build & Development Commands

```bash
# Build (runs Rust tests then compiles FFI)
deno task build

# Build Rust FFI only
deno task build:rust

# Run all checks (type-check + format + lint)
deno task check

# Run all tests (check + TS tests + Rust tests)
deno task test

# TypeScript tests only
deno task test:ts

# Rust unit tests only
deno task test:rust

# Hardware integration tests (requires EtherCAT network)
IF=eth0 deno task test:hardware

# Single TS test file
deno test --allow-ffi --allow-read --allow-write --allow-env --unstable-ffi src/tests/api.test.ts

# Single Rust integration test
ETHERCAT_INTERFACE=eth0 cargo test --test integration_test test_name -- --test-threads=1

# Lint
deno task lint

# Run examples
IF=eth0 deno task example:cycle
deno -A --unstable-ffi examples/discover.ts discovered.json eth0
```

## Architecture

```
TypeScript (EcMaster class)  →  Deno FFI  →  Rust cdylib (ethercrab_ffi)  →  ethercrab crate
```

**Key layers:**

- **`src/ec_master.ts`** — Main public API class. Manages lifecycle (init → state transitions → cyclic I/O → close), PDO mappings, and event emission.
- **`src/ffi/symbols.ts`** — FFI symbol definitions with explicit `nonblocking` flags. Network I/O ops are async (`nonblocking: true`), memory reads are sync.
- **`ethercrab_ffi/src/lib.rs`** — Rust FFI layer. Uses `parking_lot::Mutex` with global singletons (`STATE`, `GLOBAL_DEVICE`, `TX_RX_RESOURCES`). All FFI exports are panic-caught.
- **`ethercrab/`** — Upstream ethercrab Rust library (cloned separately via `git clone https://github.com/alex-controlx/ethercrab.git`).

**Process Data Image (PDI):** Monolithic buffer layout `[Outputs | Inputs]`, max 4096 bytes, shared zero-copy between Rust and TypeScript via `Uint8Array` view over FFI pointer.

**ENI parsing:** `src/utils/parse-eni.ts` handles XML/JSON EtherCAT Network Information files. `src/utils/process-data-mapper.ts` maps variable names to buffer byte/bit offsets.

**Resource lifecycle:** `ethercrab_destroy()` must be called before re-initialization. The `close()` method handles cleanup. Rust integration tests must call destroy before init.

## Code Conventions

- **TypeScript:** Strict mode. Formatter: 2-space indent, 100-char lines, double quotes, semicolons.
- **Prefer `interface` over `type`** for object shapes.
- **Always use `deno task build`** to compile Rust FFI code.
- **Test complex FFI APIs** by creating basic TS functions in `./tmp/` folder.
- Rust integration tests use `serial_test` crate — they share global state and must run sequentially (`--test-threads=1`).

## Platform Notes

- **Linux:** Requires `CAP_NET_RAW` or root (`sudo setcap 'cap_net_raw,cap_net_admin=eip' $(which deno)`)
- **macOS:** Uses BPF devices, no special privileges needed
- **Windows:** Requires Npcap with WinPcap compatibility mode
