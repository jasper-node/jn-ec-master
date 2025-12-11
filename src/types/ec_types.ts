import { ProcessDataMapping } from "./eni-config.ts";

export enum SlaveState {
  INIT = 0,
  PRE_OP = 1,
  SAFE_OP = 2,
  OP = 3,
}

/**
 * EtherCAT register addresses from ETG1000.4 Table 31.
 */
export enum RegisterAddress {
  /** Watchdog divider, u16. See ETG1000.4 section 6.3 Watchdogs. Default ~2498, gives ~100µs per count. */
  WATCHDOG_DIVIDER = 0x0400,
  /** PDI watchdog timeout, u16. */
  PDI_WATCHDOG = 0x0410,
  /** Sync manager watchdog timeout, u16. Default ~1000 with default divider = ~100ms. */
  SM_WATCHDOG = 0x0420,
  /** Sync manager watchdog status (1 bit), u16. */
  SM_WATCHDOG_STATUS = 0x0440,
  /** Sync manager watchdog counter, u8. */
  SM_WATCHDOG_COUNTER = 0x0442,
  /** PDI watchdog counter, u8. */
  PDI_WATCHDOG_COUNTER = 0x0443,
}

// Based on EtherCAT specification and ethercrab mappings
export enum AlStatusCode {
  NoError = 0x0000,
  UnspecifiedError = 0x0001,
  NoMemory = 0x0002,
  InvalidDeviceSetup = 0x0003,
  Reserved = 0x0004,
  InvalidOutputConfiguration = 0x001D,
  InvalidInputConfiguration = 0x001E,
  // Add more as needed from ETG.1000.6
  SyncManagerWatchdog = 0x001B,
  FreeRunNeedsThreeBufferMode = 0x0015,
  BackgroundWatchdog = 0x0016,
}

export interface StateChangeEvent {
  previousState: SlaveState;
  currentState: SlaveState;
  slaveIndex?: number;
}

export interface EmergencyEvent {
  slaveId: number;
  errorCode: number;
  errorReg: number;
}

export interface PdoMapping extends ProcessDataMapping {
  currentValue?: number | boolean;
  newValue?: number | boolean;
}
