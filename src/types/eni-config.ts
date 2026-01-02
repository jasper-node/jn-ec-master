// ENI-based configuration with defaults
export interface EniConfig {
  // Master configuration (from <EtherCATConfig><Config><Master>)
  master: {
    info?: {
      name: string;
      destination?: string; // MAC address
      source?: string; // MAC address
      etherType?: string;
    };
    mailboxStates?: {
      startAddr: number;
      count: number;
    };
    initCommands?: InitCommand[];
    // IMPORTANT: When using cycle times > 100ms, you must configure the SM watchdog timeout
    cycleTime?: number; // Default: 10000 (10ms in microseconds)
    dcSupport?: boolean; // Default: false
    /**
     * SM Watchdog timeout in milliseconds. Default: undefined (use slave defaults, typically ~100ms).
     *
     * The SM watchdog resets outputs to safe state if no valid process data is received
     * within this timeout. Set to a value higher than your cycle time to prevent unwanted
     * output resets, or 0 to disable (NOT RECOMMENDED for safety-critical applications).
     *
     * Example: If cycleTime is 1000000 (1s), set watchdogTimeoutMs to at least 2000 (2s).
     */
    watchdogTimeoutMs?: number;

    /**
     * Non-standard runtime options for the wrapper (not part of ENI spec).
     */
    runtimeOptions?: {
      pduTimeoutMs?: number;
      stateTransitionTimeoutMs?: number;
      mailboxResponseTimeoutMs?: number;
      eepromTimeoutMs?: number;
      pduRetries?: number;
    };
  };

  // Network interface (not in ENI, but required for execution)
  interface: string; // Required: "en0", "eth0", etc.
  ecTimeoutRet_ms?: number; // Default: 3000

  // Slave configuration (from <Config><Slave>)
  slaves: EniSlaveConfig[];

  // Cyclic Configuration (from <Config><Cyclic>)
  cyclic?: EniCyclicConfig;

  // Process Image (Global mappings from <Config><ProcessImage>)
  processImage?: ProcessImage;

  // Derived Process data mappings (optional, for convenience)
  processData?: {
    inputSize: number;
    outputSize: number;
    mappings: ProcessDataMapping[];
  };
}

export interface EniCyclicConfig {
  cycleTime?: number; // Microseconds
  tasks?: EniCyclicTask[];
}

export interface EniCyclicTask {
  cycleTime?: number;
  priority?: number;
  frames: EniCyclicFrame[];
}

export interface EniCyclicFrame {
  cmds: EniCyclicCmd[];
}

export interface EniCyclicCmd {
  cmd: number; // Command ID (e.g., 7 for LRW, 10 for LRD, 11 for LWR)
  addr: number; // Logical Address
  dataLength: number;
  inputOffset: number;
  outputOffset: number;
  cnt: number; // Working Counter
  copyInfos?: EniCopyInfo[]; // For Slave-to-Slave communication
}

export interface EniCopyInfo {
  srcBitOffset: number;
  dstBitOffset: number;
  bitSize: number;
}

export interface EniSlaveConfig {
  // From <Slave><Info>
  name: string; // Device name
  physAddr?: number;
  autoIncAddr?: number;
  vendorId?: number; // For verification (Feature 302)
  productCode?: number; // For verification
  revisionNumber?: number;
  serialNumber?: number; // For verification (optional)
  previousPort?: {
    port: string; // "A", "B", "C", "D"
    physAddr: number; // Physical address of the previous slave
  };

  // From <Slave><ProcessData> (optional, might be in ProcessImage)
  processData?: {
    inputOffset?: number; // Byte offset in PDI
    inputBitLength?: number; // Explicit bit length from ENI (from <Recv><BitLength>)
    outputOffset?: number; // Byte offset in PDI
    outputBitLength?: number; // Explicit bit length from ENI (from <Send><BitLength>)
    entries?: ProcessDataEntry[];
  };

  // From <Slave><Mailbox><Recv>
  mailboxStatusAddr?: number; // Register address for mailbox status (e.g. 0x80D)
  pollTime?: number; // Mailbox Polling interval in ms (Feature 404)

  // From <Slave><Mailbox><Protocol> and <Slave><Mailbox><CoE/EoE/FoE>
  supportsCoE?: boolean;
  supportsEoE?: boolean;
  supportsFoE?: boolean;

  // From <Slave><InitCmds>
  initCommands?: InitCommand[];
}

export interface ProcessDataEntry {
  name: string; // Variable name from ENI
  index: number; // SDO index
  subIndex: number; // SDO subindex
  bitLen: number; // Bit length
  dataType: string; // "BOOL", "INT16", etc.
  pdoOffset: number; // Byte offset in PDO
  pdiOffset: number; // Calculated: byte offset in PDI
}

export interface ProcessDataMapping {
  variableName: string; // e.g., "EL1809.Input_PDO_0" (from processImage.variables)
  pdiByteOffset: number; // Absolute offset in PDI buffer
  bitOffset?: number; // For BOOL types (within-byte position 0-7)
  dataType: string;
  slaveIndex: number;
  isInput: boolean;
  bitSize: number;
}

export interface InitCommand {
  // Expanded to support ETG.2100 ECatCmdType and MailboxCmdType

  // Helper to identify type for FFI mapping
  type: "sdo" | "soe" | "register" | "unknown";

  transition?: string[]; // e.g. ["IP", "PS"]
  comment?: string;
  timeout?: number;
  requires?: "cycle" | "frame"; // 'cycle' = separate cycle, 'frame' = separate frame

  // For Register Access (Cmd 1, 2, 4, 5, etc.)
  cmd?: number; // EtherCAT Command ID
  adp?: number; // Address Position
  ado?: number; // Address Offset (Register)
  addr?: number; // Logical Address

  // For SDO Access (CoE)
  index?: number;
  subIndex?: number;

  // For SoE Access (SoE)
  opCode?: number; // OpCode for SoE
  driveNo?: number; // Drive number for SoE
  idn?: number; // IDN for SoE

  // Data
  data?: string; // Hex string or raw bytes
  dataLength?: number;
  value?: number | string; // Parsed value
  checkCrc?: string; // CRC check value if needed

  // Validation
  validate?: {
    data: string;
    dataMask?: string;
    timeout?: number;
    type?: string; // EQ, NE, etc.
  };

  cnt?: number; // Expected WKC
  retries?: number;

  slaveIndex: number; // Which slave (0-based) - Context dependent
}

export interface ProcessImage {
  inputs: {
    byteSize: number;
    variables: ProcessVariable[];
  };
  outputs: {
    byteSize: number;
    variables: ProcessVariable[];
  };
}

export interface ProcessVariable {
  name: string;
  dataType: string;
  bitSize: number;
  bitOffset: number;
  comment?: string;
}
