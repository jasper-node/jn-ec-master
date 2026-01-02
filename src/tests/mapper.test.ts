import { buildProcessDataMappings } from "../utils/process-data-mapper.ts";
import { EniConfig } from "../types/eni-config.ts";
import { assertEquals } from "@std/assert";

Deno.test("Process Data Mapper - Basic Mapping", () => {
  const config: EniConfig = {
    master: {
      cycleTime: 10000, // 10ms (Feature 201)
      dcSupport: false,
      runtimeOptions: { networkInterface: "eth0" },
    },
    slaves: [
      {
        name: "Drive1",
        // Feature 302: Identity Verification (MANDATORY)
        vendorId: 0x00000002, // Example: Beckhoff
        productCode: 0x12345678,
        revisionNumber: 0x0001,
        serialNumber: 0,

        // Feature 404: Mailbox Polling (MANDATORY)
        pollTime: 20, // Check mailbox every 20ms

        processData: {
          // Optimized Layout: Outputs first, then Inputs
          // Output: BitStart 0, BitLength 16 (2 bytes)
          outputOffset: 0,
          outputBitLength: 16,
          // Input: BitStart 0 (relative to Input section), BitLength 16 (2 bytes)
          inputOffset: 0,
          inputBitLength: 16,
          entries: [
            {
              name: "Control", // Output (Master -> Slave)
              index: 0x6040,
              subIndex: 0,
              bitLen: 16,
              dataType: "UINT16",
              pdoOffset: 0,
              pdiOffset: 0, // Starts at 0
            },
            {
              name: "Status", // Input (Slave -> Master)
              index: 0x6041,
              subIndex: 0,
              bitLen: 16,
              dataType: "UINT16",
              pdoOffset: 0,
              pdiOffset: 2, // Starts immediately after Control word (2 bytes)
            },
          ],
        },

        // Feature 104: Initialization (Highly Recommended for Drives)
        initCommands: [
          {
            // Example: Set Max Torque to 1000 (0x03E8)
            type: "sdo",
            transition: ["PS"], // PreOp -> SafeOp
            index: 0x6072,
            subIndex: 0,
            value: 1000,
            dataLength: 2,
            slaveIndex: 0,
          },
        ],
      },
    ],
    // ProcessImage with variables matching the slave configuration
    processImage: {
      outputs: {
        byteSize: 2, // 16 bits = 2 bytes
        variables: [
          {
            name: "Drive1.Control",
            dataType: "UINT16",
            bitSize: 16,
            bitOffset: 0, // Relative to Output section start
          },
        ],
      },
      inputs: {
        byteSize: 2, // 16 bits = 2 bytes
        variables: [
          {
            name: "Drive1.Status",
            dataType: "UINT16",
            bitSize: 16,
            bitOffset: 0, // Relative to Input section start
          },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);

  assertEquals(mappings.size, 2);

  // Check Status mapping (Input)
  const statusMapping = mappings.get("Drive1.Status");
  if (!statusMapping) throw new Error("Drive1.Status not found");
  // Inputs come after outputs: outputSize (2) + inputByteOffset (0) = 2
  assertEquals(statusMapping.pdiByteOffset, 2);
  assertEquals(statusMapping.slaveIndex, 1);
  assertEquals(statusMapping.isInput, true);

  // Check Control mapping (Output)
  const controlMapping = mappings.get("Drive1.Control");
  if (!controlMapping) throw new Error("Drive1.Control not found");
  // Outputs start at 0
  assertEquals(controlMapping.pdiByteOffset, 0);
  assertEquals(controlMapping.slaveIndex, 1);
  assertEquals(controlMapping.isInput, false);
});
