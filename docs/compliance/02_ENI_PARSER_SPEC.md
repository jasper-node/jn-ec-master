### 1. Mandatory Schema Properties for Class B Compliance

The following XML paths from the ENI file are **required** to support the mandatory features of a Class B Master.

#### A. Network Verification (Feature 302)

**Requirement:** The Master **shall** compare the configured network configuration with the existing network during boot-up.
**ENI Properties to Support:**

- **`<Config><Slave><Info><VendorId>`**: Mandatory verification.
- **`<Config><Slave><Info><ProductCode>`**: Mandatory verification.
- **`<Config><Slave><Info><RevisionNo>`**: Mandatory verification.
- **`<Config><Slave><Info><SerialNo>`**: Mandatory verification.
- **`<Config><Slave><Info><PhysAddr>`**: Required to address the specific slave for verification.

#### B. Cyclic Process Data (Feature 201)

**Requirement:** The Master **shall** support cyclic process data exchange.
**ENI Properties to Support:**

- **`<Config><Cyclic><CycleTime>`**: Defines the base tick rate for your Deno loop.
- **`<Config><Cyclic><Frame><Cmd>`**: Defines the actual EtherCAT commands (LWR, LRD, etc.) to be sent.
  - **`<Cmd><DataLength>`**: Required to size your Shared Memory buffer.
  - **`<Cmd><InputOffs>` / `<OutputOffs>`**: Required to map the raw frame data to the correct location in your Process Image.
- **`<Config><ProcessImage><Inputs>/<Outputs><ByteSize>`**: Defines the total size of the process image.

#### C. Mailbox Polling (Feature 404)

**Requirement:** The Master **shall** poll the Mailbox state in slaves.
**ENI Properties to Support:**

- **`<Config><Slave><Mailbox><Recv>`**: Defines the input mailbox settings.
- **You must support at least one of the following to comply:**
  1. **`<PollTime>`**: Configures the master to check the mailbox status register at a fixed interval.
  2. **`<StatusBitAddr>`**: Configures the master to check a specific bit in the Process Data (FMMU mapped) to detect new mail.

#### D. EtherCAT State Machine & Initialization (Feature 104)

**Requirement:** The Master **shall** support the EtherCAT State Machine and special behavior.
**ENI Properties to Support:**

- **`<Config><Slave><InitCmds>`**: These contain the sequence of commands (register writes, SDO downloads) required to move a slave from `Init` $\to$ `PreOp` $\to$ `SafeOp` $\to$ `Op`.
  - **`<InitCmd><Transition>`**: Tells the master _when_ to execute the command (e.g., "PS" for PreOp to SafeOp).
  - **`<InitCmd><Cmd>` / `<Adp>` / `<Ado>` / `<Data>`**: The actual instruction to execute.

#### E. Slave-to-Slave Communication (Feature 1201)

**Requirement:** The Master **shall** support copying data between slaves (Slave-to-Slave).
**ENI Properties to Support:**

- **`<Config><Cyclic><Frame><Cmd><CopyInfos>`**: Contains the instructions for the master to copy data from an input offset to an output offset within the process image.

#### F. Protocol Support & Emergency Handling (Feature 505 & 402)

**Requirement:** The Master **shall** detect supported mailbox protocols to enable the **Mailbox Resilient Layer** and **Emergency Message Listeners**.
**ENI Properties to Support:**

- **`<Config><Slave><Mailbox><CoE>`**: Presence implies CoE support.
- **`<Config><Slave><Mailbox><Protocol>`**: Explicit declaration (e.g., "CoE", "EoE", "FoE").
- **Usage:** The parser must set a `supportsCoE` flag if either `<CoE>` element or `<Protocol>CoE</Protocol>` tag is present. This flag triggers the initialization of the Emergency Message polling loop in the master wrapper. Similarly, `supportsEoE` and `supportsFoE` flags are set based on protocol detection.

### 2. Summary Checklist for JasperNode

To certify JasperNode as a **Class B Master**, your TypeScript ENI Parser must successfully extract and utilize the following data structure:

| ENI Tag Path                           | Linked Class B Feature (ETG.1500) | Usage in JasperNode                                                                |
| :------------------------------------- | :-------------------------------- | :--------------------------------------------------------------------------------- |
| `<Slave><Info><VendorId/ProductCode>`  | **Feature 302** (Compare Config)  | Pass to `ethercrab` to validate physical topology matches XML.                     |
| `<Cyclic><Frame><Cmd>`                 | **Feature 201** (Cyclic PDO)      | Build the cyclic command list sent to the Rust backend.                            |
| `<Cyclic><Frame><Cmd><CopyInfos>`      | **Feature 1201** (Slave-to-Slave) | Implement a memory copy routine (memcpy) in Deno/Rust between inputs and outputs.  |
| `<Slave><Mailbox><Recv><PollTime>`     | **Feature 404** (Mailbox Polling) | Set up a timer to check for incoming mailbox messages (CoE/EoE).                   |
| `<Slave><Mailbox><Protocol>` / `<CoE>` | **Feature 505** (Emergency)       | Detect protocol support to enable Emergency Message listeners and Resilient Layer. |
| `<Slave><InitCmds><InitCmd>`           | **Feature 104** (ESM)             | Execute these commands during the state change sequence.                           |

### 3. Architecture Visual

This parsing strategy ensures you meet the "Minimum" requirements without over-engineering features reserved for Class A (like Redundancy or Distributed Clocks, unless you specifically opt-in to them).
