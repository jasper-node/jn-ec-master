import {
  EMERGENCY_INFO_SIZE,
  ethercrabSymbols,
  FFI_PDO_ENTRY_INFO_SIZE,
  FFI_PDO_INFO_SIZE,
  FFI_SLAVE_INFO_SIZE,
  INIT_COMMAND_SIZE,
  SLAVE_IDENTITY_SIZE,
} from "./ffi/symbols.ts";
import {
  AlStatusCode,
  EmergencyEvent,
  PdoMapping,
  RegisterAddress,
  SlaveState,
  StateChangeEvent,
} from "./types/ec_types.ts";
import {
  EniConfig,
  EniSlaveConfig,
  InitCommand,
  ProcessDataEntry,
  ProcessVariable,
} from "./types/eni-config.ts";
import {
  EtherCatError,
  FfiError,
  PdoIntegrityError,
  StateTransitionError,
} from "./types/errors.ts";
import { buildProcessDataMappings } from "./utils/process-data-mapper.ts";
import { EventEmitter } from "node:events";
import { join } from "@std/path";

export { AlStatusCode, RegisterAddress, SlaveState };
export type { EmergencyEvent, EniConfig, StateChangeEvent };

/**
 * Get the platform and architecture-specific library filename.
 * Matches the naming convention from GitHub Actions workflow build.yml.
 * @returns The library filename for the current platform and architecture
 */
function getLibraryFilename(): string {
  const os = Deno.build.os;
  const arch = Deno.build.arch;

  switch (os) {
    case "darwin": {
      if (arch === "aarch64") {
        return "libethercrab_ffi-aarch64.dylib";
      } else if (arch === "x86_64") {
        return "libethercrab_ffi-x86_64.dylib";
      } else {
        throw new Error(`Unsupported macOS architecture: ${arch}`);
      }
    }
    case "linux": {
      if (arch === "aarch64") {
        return "libethercrab_ffi-aarch64.so";
      } else if (arch === "x86_64") {
        return "libethercrab_ffi-x86_64.so";
      } else {
        throw new Error(`Unsupported Linux architecture: ${arch}`);
      }
    }
    case "windows": {
      // Windows only supports x86_64
      return "libethercrab_ffi.dll";
    }
    default:
      throw new Error(`Unsupported platform: ${os}`);
  }
}

export class EcMaster extends EventEmitter {
  static defaultDirPath: string = join(Deno.cwd(), "lib-jn-ec-master");
  private dl: Deno.DynamicLibrary<typeof ethercrabSymbols>;
  private pdiBuffer: Uint8Array | null = null;
  private pdiView: DataView | null = null;
  private processDataMappings: Map<string, PdoMapping> = new Map();
  private inputMappings: PdoMapping[] = [];
  private outputMappings: PdoMapping[] = [];
  private eniConfig: EniConfig;
  private mailboxPollingInterval?: number; // Timer ID
  private mailboxToggleBits: Map<number, number> = new Map(); // slaveIndex -> 0 or 1
  private emergencyPollingInterval?: number; // Timer ID
  private lastEmergencySlave: Map<number, EmergencyEvent> = new Map(); // Track per-slave

  private isClosed = false;
  static REQUIRED_FFI_VERSION = "0.1.6";

  // FAULT TOLERANCE CONFIGURATION
  // 5 consecutive timeouts @ 20ms cycle = 100ms "Ride Through" duration
  private static readonly MAX_MISSED_CYCLES = 5;
  private missedCycleCount = 0;

  /**
   * Open the platform-specific dynamic library.
   * @returns A Deno.DynamicLibrary instance for the ethercrab FFI symbols
   */
  private static openLibrary(dirPath: string): Deno.DynamicLibrary<typeof ethercrabSymbols> {
    const libFilename = getLibraryFilename();
    const libPath = join(dirPath, libFilename);

    try {
      Deno.statSync(libPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(
          `EtherCAT library not found at ${libPath}.\n` +
            `Please run the following command to download the binaries:\n` +
            `deno run --allow-run --allow-net --allow-write --allow-read jsr:@controlx-io/jn-ec-master/scripts/download-binaries.ts`,
        );
      }
      throw error;
    }

    let lib: Deno.DynamicLibrary<typeof ethercrabSymbols>;
    try {
      lib = Deno.dlopen(libPath, ethercrabSymbols);
    } catch (error) {
      // Handle symbol mismatch or other loading errors
      if (
        error instanceof Error &&
        (error.message.includes("Symbol") || error.message.includes("procedure"))
      ) {
        throw new Error(
          `EtherCAT library incompatible (load failed).\n` +
            `Please run the following command to download the binaries:\n` +
            `deno run --allow-run --allow-net --allow-write --allow-read jsr:@controlx-io/jn-ec-master/scripts/download-binaries`,
        );
      }
      throw error;
    }

    try {
      const buf = new Uint8Array(64);
      const len = lib.symbols.ethercrab_version(buf, BigInt(buf.length));
      const version = new TextDecoder().decode(buf.subarray(0, len));

      if (version !== EcMaster.REQUIRED_FFI_VERSION) {
        lib.close();
        throw new Error(
          `EtherCAT library version mismatch.\n` +
            `Expected: ${EcMaster.REQUIRED_FFI_VERSION}, Found: ${version}\n` +
            `Please run the following command to download the binaries:\n` +
            `deno run --allow-run --allow-net --allow-write --allow-read jsr:@controlx-io/jn-ec-master/scripts/download-binaries.ts`,
        );
      }
    } catch (error) {
      lib.close();
      if (error instanceof TypeError && error.message.includes("not a function")) {
        throw new Error(
          `EtherCAT library version check failed.\n` +
            `Please run the following command to download the binaries:\n` +
            `deno run --allow-run --allow-net --allow-write --allow-read jsr:@controlx-io/jn-ec-master/scripts/download-binaries.ts`,
        );
      }
      throw error;
    }

    return lib;
  }

  constructor(eniConfig: EniConfig, dirPath?: string) {
    super();

    this.eniConfig = eniConfig;
    this.dl = EcMaster.openLibrary(dirPath || EcMaster.defaultDirPath);
  }

  /**
   * Discovery Mode: Scan network and generate EniConfig
   */
  static async discoverNetwork(interfaceName: string, dirPath?: string): Promise<EniConfig> {
    // Retry configuration constants
    const MAX_SCAN_RETRIES = 5;
    const BASE_RETRY_DELAY_MS = 50;
    const MAX_RETRY_DELAY_MS = 500;

    const dl = EcMaster.openLibrary(dirPath || EcMaster.defaultDirPath);

    try {
      // [Step 1] PROACTIVE CLEANUP: Ensure any previous state is cleared
      // This reduces the chance of hitting the lock in the first place
      dl.symbols.ethercrab_destroy();

      const interfaceNameBuffer = new TextEncoder().encode(
        interfaceName + "\0",
      );

      // [Step 2] RETRY LOOP with exponential backoff
      let ctx: Deno.PointerValue | null = null;
      let lastErrorMsg: string | null = null;

      for (let attempt = 0; attempt <= MAX_SCAN_RETRIES; attempt++) {
        // Attempt scan
        // Note: ethercrab_scan_new returns null pointer if STATE is locked
        ctx = await dl.symbols.ethercrab_scan_new(interfaceNameBuffer);

        // Check if we got a valid pointer (not null and not 0n)
        if (ctx !== null && ctx !== undefined) {
          const ctxValue = Deno.UnsafePointer.value(ctx);
          if (ctxValue !== 0n) {
            break; // Success, exit loop
          }
        }

        // Check for specific errors that should abort retries immediately
        const errorBuf = new Uint8Array(1024);

        const errorLen = dl.symbols.ethercrab_get_last_error(
          errorBuf,
          BigInt(errorBuf.length),
        );
        if (errorLen > 0) {
          const errorMsg = new TextDecoder().decode(errorBuf.slice(0, errorLen)).trim();
          if (errorMsg.length > 0) {
            lastErrorMsg = errorMsg;
          }
          // Permission errors are fatal and should not be retried
          if (
            errorMsg.includes("Permission denied") || errorMsg.includes("Operation not permitted")
          ) {
            throw new Error(
              `Network discovery failed: ${errorMsg}. (Are you running with sudo/admin privileges?)`,
            );
          }
        }

        // If we failed and have retries left, wait and retry
        if (attempt < MAX_SCAN_RETRIES) {
          // Exponential backoff with cap
          const rawDelay = Math.min(
            BASE_RETRY_DELAY_MS * Math.pow(2, attempt),
            MAX_RETRY_DELAY_MS,
          );
          // Jitter: +/- 20% to avoid synchronized retry storms
          const jitter = rawDelay * 0.4 * (Math.random() - 0.5);
          const finalDelay = Math.max(10, Math.floor(rawDelay + jitter));

          // Log warning only if it's not the very first immediate retry
          if (attempt > 0) {
            const detail = lastErrorMsg
              ? `Discovery failed: ${lastErrorMsg}.`
              : "Discovery lock contention.";
            console.warn(
              `[EtherCAT] ${detail} Retrying in ${finalDelay}ms (Attempt ${
                attempt + 1
              }/${MAX_SCAN_RETRIES})...`,
            );
          }

          await new Promise((r) => setTimeout(r, finalDelay));
        }
      }

      // Final check: if we still don't have a valid context, throw error
      if (ctx === null || ctx === undefined) {
        const detail = lastErrorMsg
          ? ` Last error: ${lastErrorMsg}.`
          : " The EtherCAT master driver is busy or locked.";
        throw new Error(
          `Failed to start network scan after ${MAX_SCAN_RETRIES} attempts.${detail}`,
        );
      }

      const ctxValue = Deno.UnsafePointer.value(ctx);
      if (ctxValue === 0n) {
        const detail = lastErrorMsg
          ? ` Last error: ${lastErrorMsg}.`
          : " The EtherCAT master driver is busy or locked.";
        throw new Error(
          `Failed to start network scan after ${MAX_SCAN_RETRIES} attempts.${detail}`,
        );
      }

      // ctx is now guaranteed to be valid, proceed with scan processing

      const slaveCount = dl.symbols.ethercrab_scan_get_slave_count(ctx);
      const slaves: EniSlaveConfig[] = [];

      // PDI Layout tracking (bits)
      let currentInputBitOffset = 0;
      let currentOutputBitOffset = 0;

      const inputVariables: ProcessVariable[] = [];
      const outputVariables: ProcessVariable[] = [];

      // Track DC support across all slaves
      let anyDcSupported = false;

      const slaveInfoBuffer = new Uint8Array(FFI_SLAVE_INFO_SIZE);
      const pdoInfoBuffer = new Uint8Array(FFI_PDO_INFO_SIZE);
      const entryInfoBuffer = new Uint8Array(FFI_PDO_ENTRY_INFO_SIZE);

      for (let i = 0; i < slaveCount; i++) {
        if (dl.symbols.ethercrab_scan_get_slave(ctx, i, slaveInfoBuffer) < 0) {
          continue;
        }

        const view = new DataView(slaveInfoBuffer.buffer);
        // FfiSlaveInfo Layout:
        // 0-15: Identity (16 bytes)
        // 16-79: Name (64 bytes)
        // 80-81: Configured Addr (u16)
        // 82-83: Alias Addr (u16)
        // 84: Port Count (u8)
        // 85: Padding (u8)
        // 86-87: Mailbox Protocols (u16)
        // 88: DC Supported (u8)
        // 89: Padding (u8)

        const vendorId = view.getUint32(0, true);
        const productCode = view.getUint32(4, true);
        const revision = view.getUint32(8, true);
        const serial = view.getUint32(12, true);

        const nameBytes = slaveInfoBuffer.subarray(16, 80);
        const name = EcMaster.readName(nameBytes);
        const physAddr = view.getUint16(80, true);
        const mailboxProtocols = view.getUint16(86, true);
        const dcSupported = view.getUint8(88);

        // Parse mailbox protocol flags (CoE is the primary one we use)
        const coe = (mailboxProtocols & 0x01) !== 0;
        // Note: FoE (0x02), EoE (0x04), and SoE (0x08) flags are available but not yet used

        // Track DC support
        if (dcSupported === 1) {
          anyDcSupported = true;
        }

        // Iterate PDOs
        const pdoCount = dl.symbols.ethercrab_scan_get_pdo_count(ctx, i);

        // Track slave's local PDI usage for byte alignment later
        let slaveInputBits = 0;
        let slaveOutputBits = 0;

        // Process data entries for this slave
        const processDataEntries: ProcessDataEntry[] = [];

        for (let p = 0; p < pdoCount; p++) {
          if (dl.symbols.ethercrab_scan_get_pdo(ctx, i, p, pdoInfoBuffer) < 0) {
            continue;
          }

          const pdoView = new DataView(pdoInfoBuffer.buffer);
          // FfiPdoInfo:
          // 0: Index (u16)
          // 2: Num Entries (u8)
          // 3: Sync Manager (u8)
          // 4-67: Name (64)

          const numEntries = pdoView.getUint8(2);
          const sm = pdoView.getUint8(3);

          // SM 2 = Output (RxPDO), SM 3 = Input (TxPDO)
          const isOutput = sm === 2;
          const isInput = sm === 3;

          // Iterate Entries
          for (let e = 0; e < numEntries; e++) {
            if (
              dl.symbols.ethercrab_scan_get_pdo_entry(
                ctx,
                i,
                p,
                e,
                entryInfoBuffer,
              ) < 0
            ) {
              continue;
            }

            const entryView = new DataView(entryInfoBuffer.buffer);
            // FfiPdoEntryInfo:
            // 0: Index (u16)
            // 2: SubIndex (u8)
            // 3: BitLen (u8)
            // 4: DataType (u16)
            // 6-69: Name (64)

            const entryIdx = entryView.getUint16(0, true);
            const entrySub = entryView.getUint8(2);
            const bitLen = entryView.getUint8(3);
            const typeCode = entryView.getUint16(4, true);
            const entryNameBytes = entryInfoBuffer.subarray(6, 70);
            const entryName = EcMaster.readName(entryNameBytes) ||
              `Var_${entryIdx}_${entrySub}`;

            const dataType = EcMaster.mapCoEType(typeCode);

            // Calculate PDO offset (byte offset within the PDO)
            const pdoByteOffset = isInput
              ? Math.floor(slaveInputBits / 8)
              : Math.floor(slaveOutputBits / 8);

            // Calculate PDI offset (byte offset in the process data image)
            const pdiByteOffset = isInput
              ? Math.floor((currentInputBitOffset + slaveInputBits) / 8)
              : Math.floor((currentOutputBitOffset + slaveOutputBits) / 8);

            // Create process data entry
            processDataEntries.push({
              name: entryName,
              index: entryIdx,
              subIndex: entrySub,
              bitLen,
              dataType,
              pdoOffset: pdoByteOffset,
              pdiOffset: pdiByteOffset,
            });

            if (isInput) {
              inputVariables.push({
                name: `${name}.${entryName}`,
                dataType,
                bitSize: bitLen,
                bitOffset: currentInputBitOffset + slaveInputBits,
                comment: `Slave ${i} Input`,
              });
              slaveInputBits += bitLen;
            } else if (isOutput) {
              outputVariables.push({
                name: `${name}.${entryName}`,
                dataType,
                bitSize: bitLen,
                bitOffset: currentOutputBitOffset + slaveOutputBits,
                comment: `Slave ${i} Output`,
              });
              slaveOutputBits += bitLen;
            }
          }
        }

        // Byte align slave
        if (slaveInputBits > 0) {
          const remainder = slaveInputBits % 8;
          if (remainder !== 0) slaveInputBits += 8 - remainder;
        }
        if (slaveOutputBits > 0) {
          const remainder = slaveOutputBits % 8;
          if (remainder !== 0) slaveOutputBits += 8 - remainder;
        }

        // Build slave config
        const slaveConfig: EniSlaveConfig = {
          name,
          vendorId,
          productCode,
          revisionNumber: revision,
          serialNumber: serial,
          physAddr,
          autoIncAddr: 0 - i, // Default auto-inc
        };

        // Add process data capabilities if found
        if (processDataEntries.length > 0) {
          slaveConfig.processData = {
            entries: processDataEntries,
            // CRITICAL: Save the calculated lengths for the Mapper
            inputBitLength: slaveInputBits,
            outputBitLength: slaveOutputBits,
            // CRITICAL: Save the start offsets (converted to bytes)
            // Note: currentInputBitOffset has NOT been incremented by this slave yet,
            // so it points to the START of this slave. Perfect.
            inputOffset: Math.floor(currentInputBitOffset / 8),
            outputOffset: Math.floor(currentOutputBitOffset / 8),
          };
        }

        // Now update the global counters for the next slave
        if (slaveInputBits > 0) {
          currentInputBitOffset += slaveInputBits;
        }
        if (slaveOutputBits > 0) {
          currentOutputBitOffset += slaveOutputBits;
        }

        // Add mailbox configuration if CoE is supported
        if (coe) {
          slaveConfig.mailboxStatusAddr = 0x080D; // Standard mailbox status register
          slaveConfig.pollTime = 20; // Default 20ms poll time (Class B recommendation)
          slaveConfig.supportsCoE = true; // NEW
        }

        slaves.push(slaveConfig);
      }

      dl.symbols.ethercrab_scan_free(ctx);

      // Construct ENI
      return {
        master: {
          info: { name: "DenoMaster" },
          cycleTime: 10000, // 10ms default cycle time
          dcSupport: anyDcSupported,
          runtimeOptions: { networkInterface: interfaceName },
        },
        slaves,
        processImage: {
          inputs: {
            byteSize: Math.ceil(currentInputBitOffset / 8),
            variables: inputVariables,
          },
          outputs: {
            byteSize: Math.ceil(currentOutputBitOffset / 8),
            variables: outputVariables,
          },
        },
      };
    } finally {
      dl.close();
    }
  }

  private static readName(buffer: Uint8Array): string {
    let end = 0;
    while (end < buffer.length && buffer[end] !== 0) end++;
    return new TextDecoder().decode(buffer.subarray(0, end));
  }

  private static mapCoEType(code: number): string {
    switch (code) {
      case 0x0001:
        return "BOOL";
      case 0x0002:
        return "SINT8";
      case 0x0003:
        return "INT16";
      case 0x0004:
        return "INT32";
      case 0x0005:
        return "UINT8";
      case 0x0006:
        return "UINT16";
      case 0x0007:
        return "UINT32";
      case 0x0008:
        return "REAL32";
      case 0x0011:
        return "REAL64";
      case 0x0015:
        return "INT64";
      case 0x001B:
        return "LREAL"; // REAL64
      default:
        return "UINT8"; // Fallback
    }
  }

  /**
   * Feature 104: State Machine
   */
  async requestState(targetState: SlaveState): Promise<void> {
    const previousState = this.getState();

    // Configure watchdog timeout before transitioning to SAFE-OP
    // Must be done in PRE-OP state
    if (
      targetState === SlaveState.SAFE_OP &&
      previousState === SlaveState.PRE_OP &&
      this.eniConfig.master.watchdogTimeoutMs !== undefined
    ) {
      await this.configureWatchdogFromConfig();
    }

    const result = await this.dl.symbols.ethercrab_request_state(targetState);
    if (result < 0) {
      throw new StateTransitionError(
        `State transition failed with code ${result}: ${this.getLastError()}`,
      );
    }

    const currentState = this.dl.symbols.ethercrab_get_state();

    // Update PDI buffer view if we're now in SafeOp or Op, as PDI size is known at these states
    if (currentState === SlaveState.SAFE_OP || currentState === SlaveState.OP) {
      this.updatePdiBuffer();
    }

    this.emit("stateChange", {
      previousState,
      currentState: currentState as SlaveState,
    } as StateChangeEvent);
  }

  /**
   * Configure watchdog timeout from ENI config for all slaves.
   * Called automatically during PRE-OP -> SAFE-OP transition if watchdogTimeoutMs is set.
   */
  private async configureWatchdogFromConfig(): Promise<void> {
    const timeoutMs = this.eniConfig.master.watchdogTimeoutMs;
    if (timeoutMs === undefined) {
      return;
    }

    // Convert ms to watchdog timeout value
    // With default divider (~2498 * 40ns = ~100µs per count):
    // timeout_value = timeoutMs * 1000 / 100 = timeoutMs * 10
    // For safety, we use a simpler approximation: timeoutMs * 10
    const timeoutValue = Math.round(timeoutMs * 10);

    const slaveCount = this.eniConfig.slaves.length;
    for (let i = 0; i < slaveCount; i++) {
      try {
        await this.setSmWatchdogTimeout(i, timeoutValue);
      } catch (error) {
        // Some slaves (like EK1100 coupler) may not support watchdog configuration
        // Log warning but continue
        console.warn(
          `Warning: Could not configure watchdog for slave ${i}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  getState(): SlaveState {
    return this.dl.symbols.ethercrab_get_state() as SlaveState;
  }

  /**
   * Feature 302: Topology Verification
   */
  async verifyTopology(): Promise<void> {
    const expectedCount = this.eniConfig.slaves.length;
    const expectedBuffer = new Uint8Array(expectedCount * SLAVE_IDENTITY_SIZE);
    const view = new DataView(expectedBuffer.buffer);

    this.eniConfig.slaves.forEach((slave, i) => {
      const offset = i * SLAVE_IDENTITY_SIZE;
      // SlaveIdentity layout: vendor_id(u32), product_code(u32), revision(u32), serial_number(u32)
      view.setUint32(offset + 0, slave.vendorId || 0, true); // Little endian
      view.setUint32(offset + 4, slave.productCode || 0, true);
      view.setUint32(offset + 8, slave.revisionNumber || 0, true);
      view.setUint32(offset + 12, slave.serialNumber || 0, true);
    });

    const result = await this.dl.symbols.ethercrab_verify_topology(
      expectedBuffer,
      BigInt(expectedCount),
    );

    if (result < 0) {
      throw new EtherCatError(
        "Topology mismatch: Physical network ≠ ENI configuration",
      );
    }
  }

  /**
   * Check if raw socket is available
   */
  isRawSocketAvailable(): boolean {
    const result = this.dl.symbols.is_raw_socket_available();
    return result === 1;
  }

  /**
   * Feature 201: Cyclic PDO with Shared Memory
   */
  async initialize(): Promise<void> {
    // Prepare Init Commands
    let initCmdsBuffer = new Uint8Array(0);
    let initCmdsCount = 0;

    const allInitCmds: { cmd: InitCommand; slaveIndex: number }[] = [];
    this.eniConfig.slaves.forEach((slave, slaveIndex) => {
      if (slave.initCommands) {
        slave.initCommands.forEach((cmd) => {
          // Only push supported commands
          if (cmd.type === "sdo" || cmd.type === "register") {
            allInitCmds.push({ cmd, slaveIndex });
          }
        });
      }
    });

    if (allInitCmds.length > 0) {
      initCmdsCount = allInitCmds.length;
      initCmdsBuffer = new Uint8Array(initCmdsCount * INIT_COMMAND_SIZE);
      const view = new DataView(initCmdsBuffer.buffer);

      allInitCmds.forEach((item, i) => {
        const offset = i * INIT_COMMAND_SIZE;
        // FfiInitCommand Layout:
        // 0: slave_index (u16)
        // 2: command_type (u8)
        // 3: padding
        // 4: index (u16)
        // 6: sub_index (u8)
        // 7: value ([u8; 4])

        // slave_index
        view.setUint16(offset + 0, item.slaveIndex, true);
        // command_type (0=SDO, 1=Register)
        const type = item.cmd.type === "register" ? 1 : 0;
        view.setUint8(offset + 2, type);

        // index (u16) at offset 4 (aligned)
        // For register, use 'ado' or 'register'
        const indexVal = item.cmd.type === "sdo" ? (item.cmd.index || 0) : (item.cmd.ado || 0);

        view.setUint16(offset + 4, indexVal, true);

        // sub_index (u8) at offset 6
        view.setUint8(offset + 6, item.cmd.subIndex || 0);

        // value (u8[4]) at offset 7
        // item.cmd.value can be number or string (hex)
        const valBytes = new Uint8Array(4);
        let val = BigInt(0);

        if (typeof item.cmd.value === "string") {
          // Parse hex string
          const cleanHex = item.cmd.value.trim().replace(/^0x/i, "");
          if (cleanHex) {
            val = BigInt("0x" + cleanHex);
          }
        } else if (typeof item.cmd.value === "number") {
          val = BigInt(item.cmd.value);
        }

        const valView = new DataView(valBytes.buffer);
        valView.setUint32(0, Number(val), true); // Little endian

        for (let b = 0; b < 4; b++) {
          view.setUint8(offset + 7 + b, valBytes[b]!);
        }

        // Note: Current implementation truncates values > 32-bit.
      });
    }

    // Interface name
    const interfaceName = this.eniConfig.master.runtimeOptions.networkInterface;
    const interfaceNameBuffer = new TextEncoder().encode(interfaceName + "\0");

    // Get timeout values from runtimeOptions with safe defaults
    const runtimeOpts = this.eniConfig.master.runtimeOptions || {};
    const pduTimeoutMs = runtimeOpts.pduTimeoutMs ?? 100; // Default: 100ms
    const stateTransitionTimeoutMs = runtimeOpts.stateTransitionTimeoutMs ?? 1000; // Default: 1000ms
    const mailboxResponseTimeoutMs = runtimeOpts.mailboxResponseTimeoutMs ?? 1000; // Default: 1000ms
    const eepromTimeoutMs = runtimeOpts.eepromTimeoutMs ?? 100; // Default: 100ms
    const pduRetries = runtimeOpts.pduRetries ?? 3; // Default: 3 retries

    // 1. Initialize ethercrab
    const result = await this.dl.symbols.ethercrab_init(
      interfaceNameBuffer,
      new Uint8Array(0), // expected_slaves (not used for init)
      BigInt(0), // expected_count
      initCmdsBuffer,
      BigInt(initCmdsCount),
      BigInt(pduTimeoutMs),
      BigInt(stateTransitionTimeoutMs),
      BigInt(mailboxResponseTimeoutMs),
      BigInt(eepromTimeoutMs),
      BigInt(pduRetries),
    );

    if (result < 0) {
      throw new FfiError(
        `Initialization failed: ${this.getLastError()}`,
        result,
      );
    }

    // 2. Get PDI buffer pointer
    this.updatePdiBuffer();

    // 3. Build process data mappings from ENI
    this.processDataMappings = buildProcessDataMappings(this.eniConfig);

    // 4. Optimize mappings for fast cyclic access
    this.optimizeMappings();

    // 5. Start mailbox polling if configured
    this.startMailboxPolling();

    // 6. Start emergency message polling for CoE-capable slaves
    this.startEmergencyPolling();
  }

  async runCycle(): Promise<number> {
    // Single FFI call - Rust handles everything
    // Note: This is marked as non blocking but internally uses block_on, so it may block
    // The FFI function also updates the shared memory backing this.pdiBuffer

    // Ensure buffer is up-to-date before running cycle (in case it wasn't updated after state transition)
    // 1. Prepare PDI Buffer
    if (!this.pdiBuffer || this.pdiBuffer.length === 0) {
      const currentState = this.getState();
      if (currentState === SlaveState.SAFE_OP || currentState === SlaveState.OP) {
        this.updatePdiBuffer();
      }
    }

    // 2. Write Outputs (Always attempt to write, even if previous cycle failed)
    if (this.pdiView && this.pdiBuffer) {
      for (const mapping of this.outputMappings) {
        if (
          mapping.newValue !== undefined &&
          mapping.newValue !== mapping.currentValue
        ) {
          this.writeValueToBuffer(this.pdiView, this.pdiBuffer, mapping, mapping.newValue);
          mapping.currentValue = mapping.newValue;
        }
      }
    }

    // 3. Perform Cycle (FFI Call)
    const wkc = await this.dl.symbols.ethercrab_cyclic_tx_rx();

    // 4. ROBUST ERROR HANDLING (Feature 105)
    if (wkc < 0) {
      // CODE -2: PDU TIMEOUT (Transient)
      if (wkc === -2) {
        this.missedCycleCount++;

        // Critical Threshold Reached?
        if (this.missedCycleCount >= EcMaster.MAX_MISSED_CYCLES) {
          throw new FfiError(
            `Critical Network Failure: ${this.missedCycleCount} consecutive timeouts. Connection lost.`,
            wkc,
          );
        }

        // We return -2 so the app knows stats, but we DO NOT throw.
        return wkc;
      }

      // CODE -4: INTEGRITY ERROR (WKC Mismatch)
      if (wkc === -4) {
        // This usually means data returned but count was wrong.
        // Increment missed cycle count for integrity errors too
        this.missedCycleCount++;

        // Critical Threshold Reached?
        if (this.missedCycleCount >= EcMaster.MAX_MISSED_CYCLES) {
          const errMsg = this.getLastError();
          throw new PdoIntegrityError(`WKC mismatch: ${errMsg} (Code: ${wkc})`);
        }

        return wkc;
      }

      // OTHER FATAL ERRORS (Driver failure, etc.)
      throw new FfiError(`Cyclic task failed: ${this.getLastError()}`, wkc);
    }

    // 5. SUCCESS PATH
    // Reset the error counter immediately upon one successful packet
    this.missedCycleCount = 0;

    // 6. Read Inputs (Only parse data if cycle was successful!)
    if (this.pdiView && this.pdiBuffer) {
      for (const mapping of this.inputMappings) {
        mapping.currentValue = this.readValueFromBuffer(this.pdiView, this.pdiBuffer, mapping);
      }
    }

    return wkc;
  }

  /**
   * Get the shared Process Data Image (PDI) buffer for bulk input reading.
   *
   * **Usage Pattern:**
   * - **For reading inputs**: Use `getProcessDataBuffer()` to read all inputs at once.
   *   The buffer is automatically updated after each `runCycle()` call with the latest
   *   input data from all slaves. Use the PDI byte offsets from your mappings to access
   *   specific input values.
   *
   * - **For writing outputs**: Use `writePdoByte()` to write directly to slave outputs.
   *   This is faster and more direct than writing to the shared buffer.
   *
   * **Buffer Layout:**
   * - Bytes 0 to (output_size - 1): Output data (not used for writing - use writePdoByte instead)
   * - Bytes output_size to (total_size - 1): Input data (updated after each cycle)
   *
   * @returns A Uint8Array view into the shared PDI buffer
   * @throws Error if not initialized
   *
   * @example
   * ```typescript
   * const buffer = master.getProcessDataBuffer();
   * const mappings = master.getMappings();
   * const inputMapping = mappings.get("Slave1.Input_Voltage");
   * if (inputMapping) {
   *   const inputValue = buffer[inputMapping.pdiByteOffset];
   * }
   * ```
   */
  getProcessDataBuffer(): Uint8Array {
    if (!this.pdiBuffer) throw new Error("Not initialized");
    return this.pdiBuffer;
  }

  getMappings(): Map<string, PdoMapping> {
    return this.processDataMappings;
  }

  /**
   * Write a single byte to a slave's output process data.
   *
   * **Usage Pattern:**
   * - **For writing outputs**: Use `writePdoByte()` to write directly to slave outputs.
   *   This writes immediately to the slave's output buffer and will be sent on the next
   *   `runCycle()` call. This is the recommended method for writing outputs.
   *
   * - **For reading inputs**: Use `getProcessDataBuffer()` for bulk reading, or
   *   `readPdoByte()` for per-slave byte access.
   *
   * @param slaveIndex - Zero-based index of the slave (matches discovered slave order)
   * @param byteOffset - Byte offset within the slave's output buffer (0-based)
   * @param value - The byte value to write (0-255)
   * @returns `true` if the write succeeded, `false` otherwise
   *
   * @example
   * ```typescript
   * // Write to first output byte of slave at index 1
   * const success = master.writePdoByte(1, 0, 0xFF);
   * ```
   */
  writePdoByte(slaveIndex: number, byteOffset: number, value: number): boolean {
    const result = this.dl.symbols.ethercrab_write_process_data_byte(
      slaveIndex,
      byteOffset,
      value,
    );
    return result === 1;
  }

  /**
   * Read a single byte from a slave's input or output process data.
   *
   * This method reads directly from ethercrab's in-memory buffers, making it fast
   * and synchronous. For bulk input reading, consider using `getProcessDataBuffer()`
   * instead.
   *
   * @param slaveIndex - Zero-based index of the slave (matches discovered slave order)
   * @param byteOffset - Byte offset within the slave's buffer (0-based)
   * @param isOutput - If `true`, read from output buffer; if `false`, read from input buffer (default)
   * @returns The byte value (0-255), or 0 if the read failed
   *
   * @example
   * ```typescript
   * // Read first input byte from slave at index 1
   * const inputValue = master.readPdoByte(1, 0, false);
   *
   * // Read first output byte from slave at index 1 (to verify a write)
   * const outputValue = master.readPdoByte(1, 0, true);
   * ```
   */
  readPdoByte(slaveIndex: number, byteOffset: number, isOutput: boolean = false): number {
    return this.dl.symbols.ethercrab_read_process_data_byte(
      slaveIndex,
      byteOffset,
      isOutput,
    );
  }

  // Feature 501: SDO Operations
  async sdoRead(
    slaveIndex: number,
    index: number,
    subIndex: number,
  ): Promise<Uint8Array> {
    const buffer = new Uint8Array(256); // Max reasonable size? expedited is 4.

    const bytesRead = await this.dl.symbols.ethercrab_sdo_read(
      slaveIndex,
      index,
      subIndex,
      buffer,
      BigInt(buffer.length),
    );

    if (bytesRead < 0) {
      throw new FfiError(`SDO read failed: ${this.getLastError()}`, bytesRead);
    }
    return buffer.slice(0, bytesRead);
  }

  async sdoWrite(
    slaveIndex: number,
    index: number,
    subIndex: number,
    data: Uint8Array,
  ): Promise<void> {
    const result = await this.dl.symbols.ethercrab_sdo_write(
      slaveIndex,
      index,
      subIndex,
      data as unknown as BufferSource, // Safe because Uint8Array is BufferSource
      BigInt(data.length),
    );

    if (result < 0) {
      throw new FfiError(`SDO write failed: ${this.getLastError()}`, result);
    }
  }

  // Feature 305: EEPROM Access
  async readEEPROM(
    slaveIndex: number,
    address: number,
    len: number = 2,
  ): Promise<Uint8Array> {
    const buffer = new Uint8Array(len);
    const result = await this.dl.symbols.ethercrab_eeprom_read(
      slaveIndex,
      address,
      buffer,
      BigInt(buffer.length),
    );

    if (result < 0) {
      throw new FfiError(`EEPROM read failed: ${this.getLastError()}`, result);
    }
    return buffer.slice(0, result); // Result is bytes read
  }

  // Feature 404: Mailbox Polling
  configureMailboxPolling(intervalMs: number): void {
    const result = this.dl.symbols.ethercrab_configure_mailbox_polling(
      intervalMs,
    );
    if (result < 0) throw new FfiError("Mailbox polling config failed", result);
  }

  async checkMailbox(slaveIndex: number, statusAddr: number): Promise<boolean> {
    const result = await this.dl.symbols.ethercrab_check_mailbox(
      slaveIndex,
      statusAddr,
    );
    if (result < 0) return false; // Or throw?
    return result === 1;
  }

  /**
   * Feature 402: Mailbox Resilient Layer (Hybrid)
   * Automatic polling loop using Rust resilient function for toggle-bit verification
   */
  private startMailboxPolling(): void {
    this.stopMailboxPolling();

    // Find slaves with mailbox configuration
    const mailboxSlaves = this.eniConfig.slaves
      .map((slave, index) => ({ slave, index }))
      .filter(({ slave }) => slave.mailboxStatusAddr !== undefined && slave.pollTime !== undefined);

    if (mailboxSlaves.length === 0) return;

    // Use minimum pollTime or default 20ms
    const minPollTime = Math.min(
      ...mailboxSlaves.map(({ slave }) => slave.pollTime || 20),
      20,
    );

    // Start polling loop
    this.mailboxPollingInterval = setInterval(async () => {
      if (this.isClosed) return;

      for (const { slave, index } of mailboxSlaves) {
        if (this.isClosed) break;

        try {
          const statusAddr = slave.mailboxStatusAddr!;
          // Default 2 (first run) if not set
          const lastToggle = this.mailboxToggleBits.get(index) ?? 2;

          // CALL HYBRID RUST FUNCTION
          // Returns: 1 (New Mail), 0 (Empty), -1 (Error), -2 (Retry Failed)
          const result = await this.dl.symbols.ethercrab_check_mailbox_resilient(
            index,
            statusAddr,
            lastToggle,
          );

          // Check again after await - library might have been closed during the call
          if (this.isClosed) break;

          if (result === 1) {
            // Success: New mail detected
            // Update local toggle state (flip it)
            // If last was 0 -> new is 1.
            // If last was 1 -> new is 0.
            // If last was 2 (init) -> new is 0 (start sequence).
            const newToggle = (lastToggle === 0) ? 1 : 0; // Simple flip
            this.mailboxToggleBits.set(index, newToggle);

            // TODO: Trigger mailbox read (CoE/EoE) if needed
            // await this.readMailbox(index);
          } else if (result === -2) {
            // Rust exhausted retries
            this.emit("mailboxError", {
              slaveIndex: index,
              error: "Resilient read failed after retries",
            });
          } else if (result < 0) {
            // Other error
            this.emit("mailboxError", {
              slaveIndex: index,
              error: `Mailbox check failed: ${result}`,
            });
          }
        } catch (error) {
          if (!this.isClosed) {
            console.warn(`Mailbox polling failed for slave ${index}:`, error);
          }
        }
      }
    }, minPollTime);
  }

  private stopMailboxPolling(): void {
    if (this.mailboxPollingInterval !== undefined) {
      clearInterval(this.mailboxPollingInterval);
      this.mailboxPollingInterval = undefined;
    }
  }

  /**
   * Feature 505: CoE Emergency Message Handling
   * Automatic listener for CoE Emergency messages (0x0001)
   * @param pollInterval - The interval in milliseconds to poll for emergency messages (default: 10ms)
   */
  private startEmergencyPolling(pollInterval: number = 10): void {
    this.stopEmergencyPolling();

    // Filter for slaves where Parser found <CoE> or <Protocol>CoE</Protocol>
    const coeSlaves = this.eniConfig.slaves
      .map((slave, index) => ({ slave, index }))
      .filter(({ slave }) => slave.supportsCoE === true);

    if (coeSlaves.length === 0) return;

    this.emergencyPollingInterval = setInterval(() => {
      if (this.isClosed) return;

      // Rust stores the *last* global emergency.
      // We poll it and check if it applies to one of our CoE slaves.
      const emergency = this.getLastEmergency();

      if (emergency) {
        // Fix: Verify this slave supports CoE before processing
        const isCoeSlave = coeSlaves.some((s) => s.index === emergency.slaveId);

        if (isCoeSlave) {
          // Check if this is a new emergency (not the same as last one for this slave)
          const lastEmergency = this.lastEmergencySlave.get(emergency.slaveId);
          if (
            !lastEmergency ||
            lastEmergency.errorCode !== emergency.errorCode ||
            lastEmergency.errorReg !== emergency.errorReg
          ) {
            // New emergency detected - emit event
            this.emit("emergency", emergency);
            this.lastEmergencySlave.set(emergency.slaveId, emergency);
          }
        }
      }
    }, pollInterval);
  }

  private stopEmergencyPolling(): void {
    if (this.emergencyPollingInterval !== undefined) {
      clearInterval(this.emergencyPollingInterval);
      this.emergencyPollingInterval = undefined;
    }
  }

  // Register Read/Write (ETG1000.4)

  /**
   * Read a 16-bit register value from a slave.
   *
   * Common register addresses (from ETG1000.4):
   * - 0x0400: Watchdog Divider (default ~2498, gives ~100µs per count)
   * - 0x0410: PDI Watchdog timeout
   * - 0x0420: SM Watchdog timeout (default ~1000 with divider = ~100ms)
   * - 0x0440: SM Watchdog status
   *
   * @param slaveIndex - Zero-based index of the slave
   * @param registerAddress - Register address (e.g., 0x0420 for SM watchdog)
   * @returns The 16-bit register value
   */
  async registerRead(slaveIndex: number, registerAddress: number): Promise<number> {
    const result = await this.dl.symbols.ethercrab_register_read_u16(
      slaveIndex,
      registerAddress,
    );
    if (result < 0) {
      throw new FfiError(`Register read failed: ${this.getLastError()}`, result);
    }
    return result;
  }

  /**
   * Write a 16-bit register value to a slave.
   *
   * Common register addresses (from ETG1000.4):
   * - 0x0400: Watchdog Divider
   * - 0x0410: PDI Watchdog timeout
   * - 0x0420: SM Watchdog timeout
   *
   * @param slaveIndex - Zero-based index of the slave
   * @param registerAddress - Register address
   * @param value - The 16-bit value to write
   */
  async registerWrite(slaveIndex: number, registerAddress: number, value: number): Promise<void> {
    const result = await this.dl.symbols.ethercrab_register_write_u16(
      slaveIndex,
      registerAddress,
      value,
    );
    if (result < 0) {
      throw new FfiError(`Register write failed: ${this.getLastError()}`, result);
    }
  }

  /**
   * Read the SM watchdog timeout for a slave.
   *
   * The SM watchdog triggers if no valid process data is received within the timeout,
   * resetting outputs to a safe state (typically 0). Default is typically ~100ms.
   *
   * @param slaveIndex - Zero-based index of the slave
   * @returns The watchdog timeout value in watchdog divider units
   */
  async getSmWatchdogTimeout(slaveIndex: number): Promise<number> {
    return await this.registerRead(slaveIndex, RegisterAddress.SM_WATCHDOG);
  }

  /**
   * Set the SM watchdog timeout for a slave.
   *
   * **IMPORTANT**: Must be called in PRE-OP state before transitioning to SAFE-OP.
   *
   * The SM watchdog timeout determines how long a slave waits for valid process data
   * before resetting outputs to safe state. The actual timeout in microseconds is:
   *   timeout_us = watchdogDivider * timeoutValue * 0.04 (approximately)
   *
   * With default divider (~2498), timeout values approximately equal:
   * - 1000 = ~100ms (default)
   * - 10000 = ~1000ms (1 second)
   * - 0 = watchdog disabled (NOT RECOMMENDED for safety)
   *
   * @param slaveIndex - Zero-based index of the slave
   * @param timeoutValue - Watchdog timeout value (0 to disable, >0 to set)
   */
  async setSmWatchdogTimeout(slaveIndex: number, timeoutValue: number): Promise<void> {
    await this.registerWrite(slaveIndex, RegisterAddress.SM_WATCHDOG, timeoutValue);
  }

  /**
   * Configure watchdog timeout for all slaves.
   *
   * **IMPORTANT**: Must be called in PRE-OP state before transitioning to SAFE-OP.
   *
   * @param timeoutValue - Watchdog timeout value for all slaves
   */
  async configureAllWatchdogTimeouts(timeoutValue: number): Promise<void> {
    const slaveCount = this.eniConfig.slaves.length;
    for (let i = 0; i < slaveCount; i++) {
      await this.setSmWatchdogTimeout(i, timeoutValue);
    }
  }

  // Error Handling
  async getLastAlStatusCode(slaveIndex: number): Promise<AlStatusCode> {
    return (await this.dl.symbols.ethercrab_get_al_status_code(
      slaveIndex,
    )) as AlStatusCode;
  }

  getLastEmergency(): EmergencyEvent | null {
    if (this.isClosed) return null;

    try {
      const buffer = new Uint8Array(EMERGENCY_INFO_SIZE);
      const res = this.dl.symbols.ethercrab_get_last_emergency(buffer);
      if (res === 0) {
        const view = new DataView(buffer.buffer);
        // slave_index (u16), error_code (u16), error_register (u8)
        // Layout: 0:u16, 2:u16, 4:u8
        return {
          slaveId: view.getUint16(0, true),
          errorCode: view.getUint16(2, true),
          errorReg: view.getUint8(4),
        };
      }
      return null;
    } catch {
      // Suppress errors if library is closed
      return null;
    }
  }

  // Cleanup
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    this.stopMailboxPolling();
    this.stopEmergencyPolling();
    try {
      this.dl.symbols.ethercrab_destroy();
    } catch (_) {
      // ignore
    }

    this.dl.close();
    this.pdiBuffer = null;
    this.pdiView = null;
  }

  private getLastError(): string {
    const bufSize = 1024;
    const buffer = new Uint8Array(bufSize);
    const len = this.dl.symbols.ethercrab_get_last_error(
      buffer,
      BigInt(bufSize),
    );
    if (len <= 0) return "Unknown error (no message set)";
    return new TextDecoder().decode(buffer.subarray(0, len));
  }

  /**
   * Read a value from the PDI buffer based on data type and mapping configuration.
   * Handles all supported EtherCAT data types with proper endianness.
   * Uses cached DataView for performance (no object allocation in hot path).
   */
  private readValueFromBuffer(
    view: DataView,
    buffer: Uint8Array,
    mapping: PdoMapping,
  ): number | boolean {
    const { pdiByteOffset, bitOffset, dataType } = mapping;

    // Handle BOOL type with bit manipulation
    if (dataType === "BOOL" && bitOffset !== undefined) {
      const byteVal = buffer[pdiByteOffset] ?? 0;
      return ((byteVal >> bitOffset) & 1) === 1;
    }

    switch (dataType) {
      case "SINT8":
        return view.getInt8(pdiByteOffset);
      case "UINT8":
        return buffer[pdiByteOffset] ?? 0;
      case "INT16":
        return view.getInt16(pdiByteOffset, true); // little-endian
      case "UINT16":
        return view.getUint16(pdiByteOffset, true); // little-endian
      case "INT32":
        return view.getInt32(pdiByteOffset, true); // little-endian
      case "UINT32":
        return view.getUint32(pdiByteOffset, true); // little-endian
      case "REAL32":
        return view.getFloat32(pdiByteOffset, true); // little-endian
      case "REAL64":
      case "LREAL":
        return view.getFloat64(pdiByteOffset, true); // little-endian
      case "INT64":
        // Convert BigInt to number (may lose precision for very large values)
        return Number(view.getBigInt64(pdiByteOffset, true)); // little-endian
      default:
        // Fallback to UINT8 for unknown types
        return buffer[pdiByteOffset] ?? 0;
    }
  }

  /**
   * Write a value to the PDI buffer based on data type and mapping configuration.
   * Handles all supported EtherCAT data types with proper endianness.
   * For BOOL types, uses bit masking to preserve other bits in the byte.
   * Uses cached DataView for performance (no object allocation in hot path).
   */
  private writeValueToBuffer(
    view: DataView,
    buffer: Uint8Array,
    mapping: PdoMapping,
    value: number | boolean,
  ): void {
    const { pdiByteOffset, bitOffset, dataType } = mapping;

    // Handle BOOL type with bit manipulation
    if (dataType === "BOOL" && bitOffset !== undefined) {
      const currentByte = buffer[pdiByteOffset] ?? 0;
      const boolValue = value === true || value === 1;
      // Set or clear the specific bit without affecting other bits
      const mask = 1 << bitOffset;
      const newByte = boolValue ? (currentByte | mask) : (currentByte & ~mask);
      buffer[pdiByteOffset] = newByte;
      return;
    }

    switch (dataType) {
      case "SINT8":
        view.setInt8(pdiByteOffset, Number(value));
        break;
      case "UINT8":
        buffer[pdiByteOffset] = Number(value) & 0xff;
        break;
      case "INT16":
        view.setInt16(pdiByteOffset, Number(value), true); // little-endian
        break;
      case "UINT16":
        view.setUint16(pdiByteOffset, Number(value), true); // little-endian
        break;
      case "INT32":
        view.setInt32(pdiByteOffset, Number(value), true); // little-endian
        break;
      case "UINT32":
        view.setUint32(pdiByteOffset, Number(value), true); // little-endian
        break;
      case "REAL32":
        view.setFloat32(pdiByteOffset, Number(value), true); // little-endian
        break;
      case "REAL64":
      case "LREAL":
        view.setFloat64(pdiByteOffset, Number(value), true); // little-endian
        break;
      case "INT64":
        view.setBigInt64(pdiByteOffset, BigInt(Number(value)), true); // little-endian
        break;
      default:
        // Fallback to UINT8 for unknown types
        buffer[pdiByteOffset] = Number(value) & 0xff;
        break;
    }
  }

  /**
   * Pre-calculate separate arrays for inputs and outputs to eliminate
   * branching logic in the hot path (runCycle).
   */
  private optimizeMappings(): void {
    this.inputMappings = [];
    this.outputMappings = [];

    for (const mapping of this.processDataMappings.values()) {
      if (mapping.isInput) {
        this.inputMappings.push(mapping);
      } else {
        this.outputMappings.push(mapping);
      }
    }
  }

  private updatePdiBuffer() {
    // Get PDI info via separate functions (Deno FFI struct returns are broken for pointers)
    const totalSize = this.dl.symbols.ethercrab_get_pdi_total_size();
    const bufferPtr = this.dl.symbols.ethercrab_get_pdi_buffer_ptr();

    if (bufferPtr === null || bufferPtr === undefined) {
      if (totalSize > 0) {
        throw new Error(`Failed to get PDI buffer pointer (totalSize=${totalSize})`);
      }
      this.pdiBuffer = new Uint8Array(0);
      this.pdiView = null;
      return;
    }

    // Check if pointer is null (0n)
    const bufferPtrValue = Deno.UnsafePointer.value(bufferPtr);
    if (bufferPtrValue === 0n) {
      if (totalSize > 0) {
        throw new Error(`Failed to get PDI buffer pointer (totalSize=${totalSize})`);
      }
      this.pdiBuffer = new Uint8Array(0);
      this.pdiView = null;
      return;
    }

    if (totalSize > 0) {
      this.pdiBuffer = new Uint8Array(
        Deno.UnsafePointerView.getArrayBuffer(bufferPtr, totalSize),
      );
      // Cache DataView to avoid allocation in hot path
      this.pdiView = new DataView(
        this.pdiBuffer.buffer,
        this.pdiBuffer.byteOffset,
        this.pdiBuffer.byteLength,
      );
    } else {
      this.pdiBuffer = new Uint8Array(0);
      this.pdiView = null;
    }
  }
}
