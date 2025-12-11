# Discovery Mode Compliance Requirements

**Project:** JasperNode EtherCAT Master (Class B)
**Reference Standard:** ETG.1500 V1.0.2 (Master Classes)
**Target Library:** EtherCrab (Rust) + TypeScript Wrapper

## 1\. Objective

To implement a **Discovery Mode** that performs an online scan of the EtherCAT network (Feature 301) and generates a configuration object ("Internal ENI") sufficient to satisfy **Network Configuration Verification** (Feature 302) and **Cyclic Process Data Exchange** (Feature 201) upon subsequent system boot.

## 2\. Compliance Matrix (ETG.1500)

The Discovery Mode implementation **shall** capture the following data points to ensure Class B compliance. Failure to capture "Mandatory" items must result in a discovery error or a "Manual Configuration Required" flag.

| Feature ID | Feature Name           | Discovery Action Requirement                                                                            | Class B Status      |
| :--------- | :--------------------- | :------------------------------------------------------------------------------------------------------ | :------------------ |
| **301**    | Online Scanning        | Traverse network topology and identify all active nodes.                                                | **Mandatory**       |
| **302**    | Compare Network Config | Read **VendorID**, **ProductCode**, **RevisionNo**, and **SerialNo** from SII (EEPROM) for every slave. | **Mandatory**       |
| **201**    | Cyclic PDO             | Detect Process Data capabilities to build the cyclic I/O mapping.                                       | **Mandatory**       |
| **401**    | Support Mailbox        | Detect supported protocols (CoE, FoE, EoE) to initialize mailboxes.                                     | **Mandatory**       |
| **404**    | Mailbox Polling        | Determine if mailbox polling is required and set a default `PollTime`.                                  | **Mandatory**       |
| **1101**   | DC Support             | Detect if the slave supports Distributed Clocks (SII Category 60).                                      | **Cond. Mandatory** |
| **5.5.5**  | Access to EEPROM       | Use SII reads to fetch identity and capability info.                                                    | **Mandatory**       |

## 3\. Functional Requirements

### 3.1 Topology & Identity Scan (Feature 302)

The scanner **must** iterate through the physical topology and read the **Slave Information Interface (SII)** for every node.

- **Requirement:** For every slave `i`, read the following from the "Identity" Category (or fixed offsets):
  - `Vendor ID` (0x0010:0x0011)
  - `Product Code` (0x0012:0x0013)
  - `Revision Number` (0x0014:0x0015)
  - `Serial Number` (0x0016:0x0017)
- **Compliance Check:** If EEPROM read fails, the device **cannot** be used in a Class B compliant network (as Feature 302 cannot be fulfilled). The discovery result must mark this slave as "Invalid".

### 3.2 Capability Detection (Feature 401, 1101)

The scanner **must** determine the device's communication capabilities to configure the Master's state machines correctly.

- **Mailbox Protocols:** Read SII "General" Category (Cat 10) to check flags for CoE, FoE, SoE, and EoE.
  - _Rule:_ If `CoE` is supported, the generated config **must** enable the **Mailbox Resilient Layer** flag (Feature 402).
  - _Rule:_ If `CoE` is supported, set a default `PollTime` (e.g., 20ms).
  - _Implementation Note:_ For Class B compliance, if `CoE` is detected during discovery, the generated ENI/Internal Config **must** set the `supportsCoE` flag to `true`. This ensures the runtime automatically engages the `ethercrab_check_mailbox_resilient` FFI function for toggle-bit verification and retry logic, and initializes the Emergency Message polling loop for CoE Emergency messages (Feature 505).
- **Distributed Clocks:** Check if the device is a reference clock candidate (SII Category 60 or register 0x0980 access).
  - _Rule:_ If supported, set `dcSupported: true`.

### 3.3 PDO Mapping Discovery (Feature 201)

The scanner **must** determine the Process Data Objects (PDOs) to calculate `InputOffs` and `OutputOffs` for the cyclic frame.

- **Method A (Preferred):** Read CoE Object Dictionary `0x1C12` (RxPDO) and `0x1C13` (TxPDO) via SDO Upload.
- **Method B (Fallback):** Read SII "PDO" Categories (Cat 50/51).
- **Requirement:** The scan result must list all `Index`, `SubIndex`, and `BitLen` for every mapped PDO entry.

## 4\. Data Structure: Internal ENI

The FFI interface (Rust -\> TypeScript) **shall** return a JSON object strictly adhering to this schema to support the `EniConfig` interface.

```typescript
interface InternalEniResult {
  scanTime: number;
  slaves: {
    // Identity (Feature 302)
    identity: {
      vendorId: number; // Mandatory
      productCode: number; // Mandatory
      revision: number; // Mandatory
      serialNo: number; // Mandatory
    };

    // Topology (Feature 301)
    config: {
      configuredAddress: number; // Physical Address
      aliasAddress: number; // Feature 303 (Optional)
      portPhysics: string[]; // "MII" | "EBUS" (Feature 302 topology check)
    };

    // Capabilities (Feature 401, 1101)
    capabilities: {
      mailbox: {
        coe: boolean; // Mandatory: Drivers Feature 505 (Emergency)
        foe: boolean; // Optional
        eoe: boolean; // Optional
        resilientLayer: boolean; // Derived: Must be TRUE if coe is TRUE (Feature 402)
      };
      dc: boolean;
    };

    // Process Data (Feature 201)
    pdos: {
      inputs: { index: number; subIndex: number; bitLen: number; dataType: number }[];
      outputs: { index: number; subIndex: number; bitLen: number; dataType: number }[];
    };
  }[];
}
```

## 5\. Development Constraints

### 5.1 FFI Boundary

- **Async Execution:** The scan operation can take several seconds. It **must** be executed asynchronously in Rust (using `smol` or similar) to avoid blocking the Node.js event loop.
- **Isolation:** The scan **must not** run concurrently with the high-performance cyclic polling loop. The `ethercat_master.ts` must ensure the cyclic loop is `Stopped` before initiating a scan.

### 5.2 Error Handling Strategy

| Scenario                              | Action                                                       | Compliance Impact                                            |
| :------------------------------------ | :----------------------------------------------------------- | :----------------------------------------------------------- |
| **Slave detected, EEPROM unreadable** | Mark slave as `ERROR_SII_READ`. Return partial list.         | Fails Feature 302. Master cannot verify config on next boot. |
| **PDOs read via CoE fail**            | Fallback to SII PDOs. If empty, Mark as `MANUAL_CONFIG_REQ`. | Device usable only if user provides fixed ESI file.          |
| **DC Support ambiguous**              | Default to `false`.                                          | Safe fallback. Feature 1101 is Conditional.                  |

## 6\. Verification Checklist

Before marking "Discovery Mode" as complete, verify:

1. [ ] Scan returns correct `VendorID` and `ProductCode` for known devices.
2. [ ] `CoE` flag is correctly set for devices supporting CANopen over EtherCAT.
3. [ ] Generated JSON structure maps cleanly to `EniSlaveConfig` in `eni-config.ts`.
4. [ ] Scan fails gracefully if no cable is connected (does not crash runtime).
