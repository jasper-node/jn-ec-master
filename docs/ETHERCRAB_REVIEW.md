# EtherCAT Master Class B Compliance Report

**Report Date:** Dec 10, 2025
**Target Library:** EtherCrab (Rust) v0.6.0
**Specification:** ETG.1500 V1.0.2 (Master Classes)
**Class Level:** Class B (Minimum EtherCAT Master Device)

## 1. Executive Summary

EtherCrab currently implements the core functionalities required for a Class B Master, including **Online Scanning**, **Cyclic PDO exchange**, **CoE (SDO/PDO)**, and **Distributed Clocks (DC)**.

However, to fully meet Class B compliance, the library requires verification or implementation of specific edge-case protocols such as the **Mailbox Resilient Layer** and explicit **Error Handling** interfaces (e.g., Emergency messages). Feature packs like EoE (Ethernet over EtherCAT) and FoE (File over EtherCAT) are currently not strictly required for Class B unless the device claims support for them, but they are marked as "Shall if supported."

## 2. Compliance Matrix

### 2.1 Basic Features

| Feature ID | Feature Name                     | Class B Req. | Status            | Implementation Notes                                                                                                                    |
| :--------- | :------------------------------- | :----------- | :---------------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| **101**    | **Service Commands**             | **Shall**    | ✅ **Supported**  | Standard commands (APRD, FPRD, BRD, LRD/LWR, etc.) are implemented for enumeration and process data.                                    |
| **102**    | IRQ Field in datagram            | Should       | ⚠️ **Unverified** | Library handles WKC (Working Counter), but explicit use of the IRQ field in the datagram header for event detection needs verification. |
| **103**    | **Slaves with Device Emulation** | **Shall**    | ✅ **Supported**  | Handles AL Status codes and state transitions for complex slaves.                                                                       |
| **104**    | **EtherCAT State Machine (ESM)** | **Shall**    | ✅ **Supported**  | Fully implements state transitions (Init → PreOp → SafeOp → Op).                                                                        |
| **105**    | **Error Handling**               | **Shall**    | ⚠️ **Partial**    | WKC checking is implemented. A public API for application-level error registers and diagnosis objects is required.                      |
| **106**    | VLAN                             | May          | ⚪ Not Supported  | Optional for Class B.                                                                                                                   |
| **107**    | **EtherCAT Frame Types**         | **Shall**    | ✅ **Supported**  | Standard Ethernet frames (EtherType 0x88A4) supported.                                                                                  |

### 2.2 Process Data Exchange

| Feature ID | Feature Name     | Class B Req. | Status           | Implementation Notes                                             |
| :--------- | :--------------- | :----------- | :--------------- | :--------------------------------------------------------------- |
| **201**    | **Cyclic PDO**   | **Shall**    | ✅ **Supported** | Supports `tx_rx_task` and `PduStorage` for cyclic data exchange. |
| **202**    | Multiple Tasks   | May          | ⚪ Not Supported | Single task cycle is standard. Optional for Class B.             |
| **203**    | Frame Repetition | May          | ⚪ Not Supported | Optional for Class B.                                            |

### 2.3 Network Configuration

| Feature ID | Feature Name                      | Class B Req.       | Status           | Implementation Notes                                                                                                                            |
| :--------- | :-------------------------------- | :----------------- | :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| **301**    | **Online Scanning / Reading ENI** | **Shall (One of)** | ✅ **Supported** | Supports online scanning (Auto-Config from EEPROM/SII).                                                                                         |
| **302**    | **Compare Network Config**        | **Shall**          | ⚠️ **Partial**   | Auto-config builds the network from scan. If loading from ESI/Config, strict comparison (VendorID/ProductCode) during boot-up must be enforced. |
| **303**    | Explicit Device ID                | Should             | ⚪ Not Supported | Usage of "Configured Station Alias" or Explicit ID for Hot Connect is not a primary feature.                                                    |
| **305**    | **Access to EEPROM**              | **Shall (Read)**   | ✅ **Supported** | Full read/write support for SII EEPROM via ESC registers.                                                                                       |

### 2.4 Mailbox Support

| Feature ID | Feature Name                | Class B Req. | Status           | Implementation Notes                                                                                                                                                     |
| :--------- | :-------------------------- | :----------- | :--------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **401**    | **Support Mailbox**         | **Shall**    | ✅ **Supported** | Standard mailbox read/write is implemented.                                                                                                                              |
| **402**    | **Mailbox Resilient Layer** | **Shall**    | ❌ **Missing**   | The specification requires a state machine to recover lost mailbox frames (toggle bit verification/retry). This needs to be explicitly confirmed in the `PduLoop` logic. |
| **404**    | **Mailbox Polling**         | **Shall**    | ✅ **Supported** | Mechanisms to check mailbox status are present.                                                                                                                          |

### 2.5 Protocols (CoE, SoE, EoE, FoE)

| Feature ID     | Feature Name          | Class B Req. | Status            | Implementation Notes                                                                                                    |
| :------------- | :-------------------- | :----------- | :---------------- | :---------------------------------------------------------------------------------------------------------------------- |
| **501**        | **SDO Up/Download**   | **Shall**    | ✅ **Supported**  | Full support for Expedited and Normal SDO transfer.                                                                     |
| **502**        | Segmented Transfer    | Should       | ✅ **Supported**  | Library handles data fragmentation for larger objects.                                                                  |
| **503**        | Complete Access       | Should       | ⚠️ **Unverified** | Support for `CompleteAccess` (accessing all sub-indices at once) is recommended but not strictly mandatory.             |
| **505**        | **Emergency Message** | **Shall**    | ❌ **Missing**    | A dedicated handler/callback for CoE Emergency messages (0x0001) is required to notify the application of slave errors. |
| **601****701** | EoE / FoE Protocol    | Cond. Shall  | ⚪ Not Supported  | Not required for Class B unless the master claims support. Currently not implemented in EtherCrab.                      |
| **1101**       | **DC Support**        | Cond. Shall  | ✅ **Supported**  | Distributed Clocks (delay compensation, static drift, cyclic sync) are supported in recent versions.                    |

---

## 3. Development Action Plan

To ensure full certification compliance for Class B, the development team should prioritize the following "Missing" or "Partial" items:

### Priority 1: Mandatory Gaps

1. **Mailbox Resilient Layer (Feature 402):**
   - **Task:** Implement the retry mechanism for lost mailbox frames as defined in ETG.1000.4.
   - **Requirement:** Ensure the master retries the mailbox transfer if the toggle bit does not flip or if the Working Counter (WKC) is invalid, without dropping the connection.

2. **Emergency Message Handling (Feature 505):**
   - **Task:** Add a listener in the mailbox protocol to detect CoE Emergency messages.
   - **Requirement:** Parse the Error Code (0x6000 range) and Error Register, and expose this to the user application via an event or callback.

3. **Strict Configuration Check (Feature 302):**
   - **Task:** When initializing from a defined struct or config, ensure the master halts or warns if the `VendorID`, `ProductCode`, or `RevisionNo` read from the slave differs from the expected configuration.

### Priority 2: Recommended Enhancements ("Should")

1. **Complete Access (Feature 503):** Implement the SDO flag for Complete Access to speed up device initialization.
2. **Explicit Device ID (Feature 303):** Add support for reading the Configured Station Alias (register 0x0012) to support cable-swapping protection.
