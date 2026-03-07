import { assert, assertEquals, assertExists } from "@std/assert";
import { buildProcessDataMappings } from "../process-data-mapper.ts";
import type { EniConfig } from "../../types/eni-config.ts";

Deno.test("buildProcessDataMappings - returns empty map when processImage is missing", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [],
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 0);
});

Deno.test("buildProcessDataMappings - returns empty map when processImage has no variables", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          inputOffset: 0,
          inputBitLength: 8,
          outputOffset: 0,
          outputBitLength: 8,
        },
      },
    ],
    processImage: {
      inputs: { byteSize: 1, variables: [] },
      outputs: { byteSize: 1, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 0);
});

Deno.test("buildProcessDataMappings - maps single output variable correctly", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 1,
        variables: [
          {
            name: "Output1",
            dataType: "BYTE",
            bitSize: 8,
            bitOffset: 0,
          },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);

  const mapping = mappings.get("Output1");
  assertExists(mapping);
  assertEquals(mapping.pdiByteOffset, 0);
  assertEquals(mapping.slaveIndex, 1);
  assertEquals(mapping.isInput, false);
  assertEquals(mapping.dataType, "BYTE");
  assertEquals(mapping.bitSize, 8);
  assertEquals(mapping.bitOffset, undefined);
});

Deno.test("buildProcessDataMappings - maps single input variable correctly", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          inputOffset: 0,
          inputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: { byteSize: 1, variables: [] },
      inputs: {
        byteSize: 1,
        variables: [
          {
            name: "Input1",
            dataType: "BYTE",
            bitSize: 8,
            bitOffset: 0,
          },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);

  const mapping = mappings.get("Input1");
  assertExists(mapping);
  // PDI layout: [Outputs | Inputs], so input offset = outputSize (1) + inputByteOffset (0) = 1
  assertEquals(mapping.pdiByteOffset, 1);
  assertEquals(mapping.slaveIndex, 1);
  assertEquals(mapping.isInput, true);
  assertEquals(mapping.dataType, "BYTE");
  assertEquals(mapping.bitSize, 8);
});

Deno.test("buildProcessDataMappings - handles BOOL type with bitOffset", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          inputOffset: 0,
          inputBitLength: 16,
        },
      },
    ],
    processImage: {
      outputs: { byteSize: 0, variables: [] },
      inputs: {
        byteSize: 2,
        variables: [
          {
            name: "Bool1",
            dataType: "BOOL",
            bitSize: 1,
            bitOffset: 5, // Bit 5 in first byte
          },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);

  const mapping = mappings.get("Bool1");
  assertExists(mapping);
  assertEquals(mapping.dataType, "BOOL");
  assertEquals(mapping.bitOffset, 5); // Should preserve bit offset within byte
  assertEquals(mapping.pdiByteOffset, 0); // Output size is 0, so input starts at 0
});

Deno.test("buildProcessDataMappings - handles BOOL at byte boundary", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          inputOffset: 0,
          inputBitLength: 16, // Need at least 16 bits to cover bitOffset 8
        },
      },
    ],
    processImage: {
      outputs: { byteSize: 0, variables: [] },
      inputs: {
        byteSize: 2,
        variables: [
          {
            name: "BoolAtBoundary",
            dataType: "BOOL",
            bitSize: 1,
            bitOffset: 8, // First bit of second byte
          },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  const mapping = mappings.get("BoolAtBoundary");
  assertExists(mapping);
  assertEquals(mapping.bitOffset, 0); // 8 % 8 = 0
  assertEquals(mapping.pdiByteOffset, 1); // 8 / 8 = 1
});

Deno.test("buildProcessDataMappings - maps multiple variables from same slave", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 32,
          inputOffset: 0,
          inputBitLength: 32,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 4,
        variables: [
          { name: "Out1", dataType: "UINT16", bitSize: 16, bitOffset: 0 },
          { name: "Out2", dataType: "UINT16", bitSize: 16, bitOffset: 16 },
        ],
      },
      inputs: {
        byteSize: 4,
        variables: [
          { name: "In1", dataType: "UINT16", bitSize: 16, bitOffset: 0 },
          { name: "In2", dataType: "UINT16", bitSize: 16, bitOffset: 16 },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 4);

  assertEquals(mappings.get("Out1")?.pdiByteOffset, 0);
  assertEquals(mappings.get("Out2")?.pdiByteOffset, 2);
  assertEquals(mappings.get("In1")?.pdiByteOffset, 4); // outputSize (4) + 0
  assertEquals(mappings.get("In2")?.pdiByteOffset, 6); // outputSize (4) + 2
});

Deno.test("buildProcessDataMappings - maps variables from multiple slaves", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 8,
          inputOffset: 0,
          inputBitLength: 8,
        },
      },
      {
        name: "Slave2",
        processData: {
          outputOffset: 1,
          outputBitLength: 8,
          inputOffset: 1,
          inputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 2,
        variables: [
          { name: "Slave1.Out", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
          { name: "Slave2.Out", dataType: "BYTE", bitSize: 8, bitOffset: 8 },
        ],
      },
      inputs: {
        byteSize: 2,
        variables: [
          { name: "Slave1.In", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
          { name: "Slave2.In", dataType: "BYTE", bitSize: 8, bitOffset: 8 },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 4);

  const slave1Out = mappings.get("Slave1.Out");
  assertExists(slave1Out);
  assertEquals(slave1Out.slaveIndex, 1);
  assertEquals(slave1Out.pdiByteOffset, 0);

  const slave2Out = mappings.get("Slave2.Out");
  assertExists(slave2Out);
  assertEquals(slave2Out.slaveIndex, 2);
  assertEquals(slave2Out.pdiByteOffset, 1);

  const slave1In = mappings.get("Slave1.In");
  assertExists(slave1In);
  assertEquals(slave1In.slaveIndex, 1);
  assertEquals(slave1In.pdiByteOffset, 2); // outputSize (2) + 0

  const slave2In = mappings.get("Slave2.In");
  assertExists(slave2In);
  assertEquals(slave2In.slaveIndex, 2);
  assertEquals(slave2In.pdiByteOffset, 3); // outputSize (2) + 1
});

Deno.test("buildProcessDataMappings - handles gaps in bit ranges", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 8,
        },
      },
      {
        name: "Slave2",
        processData: {
          outputOffset: 2, // Gap: byte 1 is unused
          outputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 3,
        variables: [
          { name: "Slave1.Out", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
          { name: "Slave2.Out", dataType: "BYTE", bitSize: 8, bitOffset: 16 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 2);

  assertEquals(mappings.get("Slave1.Out")?.pdiByteOffset, 0);
  assertEquals(mappings.get("Slave2.Out")?.pdiByteOffset, 2);
});

Deno.test("buildProcessDataMappings - handles out-of-order slave definitions", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave2",
        processData: {
          outputOffset: 1,
          outputBitLength: 8,
        },
      },
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 2,
        variables: [
          { name: "Slave1.Out", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
          { name: "Slave2.Out", dataType: "BYTE", bitSize: 8, bitOffset: 8 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 2);

  // Should still match correctly based on bit offset ranges
  assertEquals(mappings.get("Slave1.Out")?.slaveIndex, 2); // Second slave in array
  assertEquals(mappings.get("Slave2.Out")?.slaveIndex, 1); // First slave in array
});

Deno.test("buildProcessDataMappings - excludes variables that don't match any slave", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 2,
        variables: [
          { name: "Matched", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
          { name: "Unmatched", dataType: "BYTE", bitSize: 8, bitOffset: 16 }, // Outside slave range
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);
  assertExists(mappings.get("Matched"));
  assert(!mappings.has("Unmatched"));
});

Deno.test("buildProcessDataMappings - handles slaves without processData", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        // No processData
      },
      {
        name: "Slave2",
        processData: {
          outputOffset: 0,
          outputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 1,
        variables: [
          { name: "Slave2.Out", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);
  assertExists(mappings.get("Slave2.Out"));
});

Deno.test("buildProcessDataMappings - handles slaves with undefined offsets", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          // Missing offsets
          inputBitLength: 8,
          outputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 1,
        variables: [
          { name: "Out", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  // Should not match because offsets are undefined
  assertEquals(mappings.size, 0);
});

Deno.test("buildProcessDataMappings - handles variables at exact boundary", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 16,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 2,
        variables: [
          { name: "Var1", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
          { name: "Var2", dataType: "BYTE", bitSize: 8, bitOffset: 8 }, // Exactly at byte boundary
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 2);

  const var1 = mappings.get("Var1");
  assertExists(var1);
  assertEquals(var1.pdiByteOffset, 0);

  const var2 = mappings.get("Var2");
  assertExists(var2);
  assertEquals(var2.pdiByteOffset, 1);
});

Deno.test("buildProcessDataMappings - handles large bit offsets", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          inputOffset: 10,
          inputBitLength: 16,
        },
      },
    ],
    processImage: {
      outputs: { byteSize: 0, variables: [] },
      inputs: {
        byteSize: 12,
        variables: [
          { name: "Var1", dataType: "UINT16", bitSize: 16, bitOffset: 80 }, // 10 bytes * 8 = 80 bits
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);

  const mapping = mappings.get("Var1");
  assertExists(mapping);
  assertEquals(mapping.pdiByteOffset, 10); // 80 / 8 = 10
});

Deno.test("buildProcessDataMappings - handles partial byte overlaps correctly", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          inputOffset: 0,
          inputBitLength: 12, // 1.5 bytes
        },
      },
    ],
    processImage: {
      outputs: { byteSize: 0, variables: [] },
      inputs: {
        byteSize: 2,
        variables: [
          { name: "Var1", dataType: "UINT16", bitSize: 12, bitOffset: 0 },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);

  const mapping = mappings.get("Var1");
  assertExists(mapping);
  assertEquals(mapping.pdiByteOffset, 0);
  assertEquals(mapping.bitSize, 12);
});

Deno.test("buildProcessDataMappings - handles multiple BOOL variables in same byte", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          inputOffset: 0,
          inputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: { byteSize: 0, variables: [] },
      inputs: {
        byteSize: 1,
        variables: [
          { name: "Bool0", dataType: "BOOL", bitSize: 1, bitOffset: 0 },
          { name: "Bool3", dataType: "BOOL", bitSize: 1, bitOffset: 3 },
          { name: "Bool7", dataType: "BOOL", bitSize: 1, bitOffset: 7 },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 3);

  assertEquals(mappings.get("Bool0")?.bitOffset, 0);
  assertEquals(mappings.get("Bool3")?.bitOffset, 3);
  assertEquals(mappings.get("Bool7")?.bitOffset, 7);
  assertEquals(mappings.get("Bool0")?.pdiByteOffset, 0);
  assertEquals(mappings.get("Bool3")?.pdiByteOffset, 0);
  assertEquals(mappings.get("Bool7")?.pdiByteOffset, 0);
});

Deno.test("buildProcessDataMappings - handles variable at end of slave range", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 8,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 1,
        variables: [
          { name: "VarAtEnd", dataType: "BYTE", bitSize: 8, bitOffset: 0 }, // Exactly fits
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);

  const mapping = mappings.get("VarAtEnd");
  assertExists(mapping);
  // Variable at bitOffset 0, length 8, should end at bit 8 (exclusive)
  // Slave range is 0-8 (exclusive), so bitOffset 0 is within range
  assertEquals(mapping.pdiByteOffset, 0);
});

Deno.test("buildProcessDataMappings - excludes variable just outside slave range", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 8, // Bits 0-8 (exclusive)
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 2,
        variables: [
          { name: "Outside", dataType: "BYTE", bitSize: 8, bitOffset: 8 }, // Starts at bit 8, outside range
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 0);
});

Deno.test("buildProcessDataMappings - handles complex multi-slave scenario", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "Slave1",
        processData: {
          outputOffset: 0,
          outputBitLength: 16,
          inputOffset: 0,
          inputBitLength: 8,
        },
      },
      {
        name: "Slave2",
        processData: {
          outputOffset: 2,
          outputBitLength: 8,
          inputOffset: 1,
          inputBitLength: 16,
        },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 3,
        variables: [
          { name: "S1.Out1", dataType: "UINT16", bitSize: 16, bitOffset: 0 },
          { name: "S2.Out1", dataType: "BYTE", bitSize: 8, bitOffset: 16 },
        ],
      },
      inputs: {
        byteSize: 3,
        variables: [
          { name: "S1.In1", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
          { name: "S2.In1", dataType: "UINT16", bitSize: 16, bitOffset: 8 },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 4);

  assertEquals(mappings.get("S1.Out1")?.slaveIndex, 1);
  assertEquals(mappings.get("S1.Out1")?.pdiByteOffset, 0);
  assertEquals(mappings.get("S2.Out1")?.slaveIndex, 2);
  assertEquals(mappings.get("S2.Out1")?.pdiByteOffset, 2);

  assertEquals(mappings.get("S1.In1")?.slaveIndex, 1);
  assertEquals(mappings.get("S1.In1")?.pdiByteOffset, 3); // outputSize (3) + 0
  assertEquals(mappings.get("S2.In1")?.slaveIndex, 2);
  assertEquals(mappings.get("S2.In1")?.pdiByteOffset, 4); // outputSize (3) + 1
});

// --- Name-based fallback tests ---

Deno.test("buildProcessDataMappings - name fallback: matches outputs when processData is missing", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      { name: "EK1100" }, // coupler, no I/O
      { name: "XI211208" },
      { name: "EL2008" },
    ],
    processImage: {
      outputs: {
        byteSize: 2,
        variables: [
          { name: "XI211208.Output_PDO_0", dataType: "BOOL", bitSize: 1, bitOffset: 0 },
          { name: "XI211208.Output_PDO_1", dataType: "BOOL", bitSize: 1, bitOffset: 1 },
          { name: "EL2008.Output_PDO_0", dataType: "BOOL", bitSize: 1, bitOffset: 8 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 3);

  const xi = mappings.get("XI211208.Output_PDO_0");
  assertExists(xi);
  assertEquals(xi.slaveIndex, 2); // index 1 in array, +1 = 2
  assertEquals(xi.isInput, false);
  assertEquals(xi.bitOffset, 0);

  const el = mappings.get("EL2008.Output_PDO_0");
  assertExists(el);
  assertEquals(el.slaveIndex, 3); // index 2 in array, +1 = 3
  assertEquals(el.pdiByteOffset, 1);
});

Deno.test("buildProcessDataMappings - name fallback: matches inputs when processData is missing", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      { name: "EL3062" },
    ],
    processImage: {
      outputs: { byteSize: 2, variables: [] },
      inputs: {
        byteSize: 4,
        variables: [
          { name: "EL3062.Value", dataType: "UINT16", bitSize: 16, bitOffset: 0 },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);

  const mapping = mappings.get("EL3062.Value");
  assertExists(mapping);
  assertEquals(mapping.slaveIndex, 1);
  assertEquals(mapping.isInput, true);
  assertEquals(mapping.pdiByteOffset, 2); // outputSize (2) + 0
});

Deno.test("buildProcessDataMappings - name fallback: skips variables with no dot separator", () => {
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [{ name: "Slave1" }],
    processImage: {
      outputs: {
        byteSize: 1,
        variables: [
          { name: "NoDotName", dataType: "BYTE", bitSize: 8, bitOffset: 0 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 0);
});

Deno.test("buildProcessDataMappings - name fallback: prefers processData match over name match", () => {
  // Slave order: [SlaveA, SlaveB] but SlaveA's processData covers bitOffset 8
  // Variable "SlaveA.Out" at bitOffset 8 should match via processData (SlaveA at index 0)
  // even though name also matches SlaveA
  const config: EniConfig = {
    master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
    slaves: [
      {
        name: "SlaveA",
        processData: { outputOffset: 1, outputBitLength: 8 },
      },
      {
        name: "SlaveB",
        processData: { outputOffset: 0, outputBitLength: 8 },
      },
    ],
    processImage: {
      outputs: {
        byteSize: 2,
        variables: [
          { name: "SlaveA.Out", dataType: "BYTE", bitSize: 8, bitOffset: 8 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  };

  const mappings = buildProcessDataMappings(config);
  assertEquals(mappings.size, 1);
  // processData says bitOffset 8 belongs to SlaveA (offset 1 * 8 = 8), index 0, +1 = 1
  assertEquals(mappings.get("SlaveA.Out")?.slaveIndex, 1);
});

Deno.test("buildProcessDataMappings - name fallback: real-world config with stripped processData", () => {
  // Mirrors the actual JN config that triggered this issue
  const config: EniConfig = {
    master: { cycleTime: 25000, runtimeOptions: { networkInterface: "en5" } },
    slaves: [
      { name: "XB-EC-12", physAddr: 4096, vendorId: 36, productCode: 2370063 },
      { name: "XI110208", physAddr: 4097, vendorId: 36, productCode: 2370051 },
      { name: "XI211208", physAddr: 4098, vendorId: 36, productCode: 2370049 },
      { name: "XI332204", physAddr: 4099, vendorId: 36, productCode: 2370061 },
      { name: "EK1100", physAddr: 4100, vendorId: 2, productCode: 72100946 },
      { name: "EL3062", physAddr: 4101, vendorId: 2, productCode: 200683602 },
      { name: "EK1100", physAddr: 4102, vendorId: 2, productCode: 72100946 },
      { name: "EL2008", physAddr: 4103, vendorId: 2, productCode: 131608658 },
      { name: "EL4002", physAddr: 4104, vendorId: 2, productCode: 262287442 },
    ],
    processImage: {
      inputs: { byteSize: 49, variables: [] },
      outputs: {
        byteSize: 6,
        variables: [
          { name: "XI211208.Output_PDO_0", dataType: "BOOL", bitSize: 1, bitOffset: 0 },
          { name: "XI211208.Output_PDO_1", dataType: "BOOL", bitSize: 1, bitOffset: 1 },
          { name: "XI211208.Output_PDO_2", dataType: "BOOL", bitSize: 1, bitOffset: 2 },
          { name: "XI211208.Output_PDO_3", dataType: "BOOL", bitSize: 1, bitOffset: 3 },
          { name: "XI211208.Output_PDO_4", dataType: "BOOL", bitSize: 1, bitOffset: 4 },
          { name: "XI211208.Output_PDO_5", dataType: "BOOL", bitSize: 1, bitOffset: 5 },
          { name: "XI211208.Output_PDO_6", dataType: "BOOL", bitSize: 1, bitOffset: 6 },
          { name: "XI211208.Output_PDO_7", dataType: "BOOL", bitSize: 1, bitOffset: 7 },
          { name: "EL2008.Output_PDO_0", dataType: "BOOL", bitSize: 1, bitOffset: 8 },
          { name: "EL2008.Output_PDO_1", dataType: "BOOL", bitSize: 1, bitOffset: 9 },
          { name: "EL2008.Output_PDO_2", dataType: "BOOL", bitSize: 1, bitOffset: 10 },
          { name: "EL2008.Output_PDO_3", dataType: "BOOL", bitSize: 1, bitOffset: 11 },
          { name: "EL2008.Output_PDO_4", dataType: "BOOL", bitSize: 1, bitOffset: 12 },
          { name: "EL2008.Output_PDO_5", dataType: "BOOL", bitSize: 1, bitOffset: 13 },
          { name: "EL2008.Output_PDO_6", dataType: "BOOL", bitSize: 1, bitOffset: 14 },
          { name: "EL2008.Output_PDO_7", dataType: "BOOL", bitSize: 1, bitOffset: 15 },
          { name: "EL4002.Entry_0x7000_01", dataType: "UINT16", bitSize: 16, bitOffset: 16 },
          { name: "EL4002.Entry_0x7010_01", dataType: "UINT16", bitSize: 16, bitOffset: 32 },
        ],
      },
    },
  };

  const mappings = buildProcessDataMappings(config);

  // All 18 output variables should be mapped
  assertEquals(mappings.size, 18);

  // Spot-check slave assignments
  assertEquals(mappings.get("XI211208.Output_PDO_0")?.slaveIndex, 3); // index 2 + 1
  assertEquals(mappings.get("XI211208.Output_PDO_2")?.slaveIndex, 3);
  assertEquals(mappings.get("EL2008.Output_PDO_0")?.slaveIndex, 8); // index 7 + 1
  assertEquals(mappings.get("EL4002.Entry_0x7000_01")?.slaveIndex, 9); // index 8 + 1

  // Check BOOL bit offsets
  assertEquals(mappings.get("XI211208.Output_PDO_2")?.bitOffset, 2);
  assertEquals(mappings.get("EL2008.Output_PDO_3")?.bitOffset, 3);

  // Check UINT16 has no bitOffset
  assertEquals(mappings.get("EL4002.Entry_0x7000_01")?.bitOffset, undefined);
  assertEquals(mappings.get("EL4002.Entry_0x7000_01")?.pdiByteOffset, 2);
  assertEquals(mappings.get("EL4002.Entry_0x7010_01")?.pdiByteOffset, 4);

  // No input mappings (variables array is empty)
  for (const mapping of mappings.values()) {
    assertEquals(mapping.isInput, false);
  }
});
