import { assertEquals } from "@std/assert";
import { findSlaveIndex, resolveSlaves } from "../resolve-slaves.ts";
import type { EniConfig } from "../../types/eni-config.ts";

const baseConfig = (overrides: Partial<EniConfig> = {}): EniConfig => ({
  master: { cycleTime: 1000, runtimeOptions: { networkInterface: "eth0" } },
  slaves: [],
  ...overrides,
});

Deno.test("resolveSlaves - returns empty variables for slaves with no process data", () => {
  const config = baseConfig({
    slaves: [
      { name: "EK1100", vendorId: 2, productCode: 72100946 },
    ],
    processImage: {
      outputs: { byteSize: 0, variables: [] },
      inputs: { byteSize: 0, variables: [] },
    },
  });

  const result = resolveSlaves(config);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.name, "EK1100");
  assertEquals(result[0]!.index, 0);
  assertEquals(result[0]!.variables.length, 0);
});

Deno.test("resolveSlaves - maps output variables to correct slave", () => {
  const config = baseConfig({
    slaves: [
      { name: "EK1100" },
      { name: "EL2008" },
    ],
    processImage: {
      outputs: {
        byteSize: 1,
        variables: [
          { name: "EL2008.Output_PDO_0", dataType: "BOOL", bitSize: 1, bitOffset: 0 },
          { name: "EL2008.Output_PDO_1", dataType: "BOOL", bitSize: 1, bitOffset: 1 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  });

  const result = resolveSlaves(config);
  assertEquals(result[0]!.variables.length, 0); // EK1100 — coupler
  assertEquals(result[1]!.variables.length, 2); // EL2008

  const v0 = result[1]!.variables[0]!;
  assertEquals(v0.name, "Output_PDO_0");
  assertEquals(v0.fullName, "EL2008.Output_PDO_0");
  assertEquals(v0.isInput, false);
  assertEquals(v0.dataType, "BOOL");
});

Deno.test("resolveSlaves - maps input variables to correct slave", () => {
  const config = baseConfig({
    slaves: [{ name: "EL3062" }],
    processImage: {
      outputs: { byteSize: 0, variables: [] },
      inputs: {
        byteSize: 4,
        variables: [
          { name: "EL3062.Value1", dataType: "UINT16", bitSize: 16, bitOffset: 0 },
          { name: "EL3062.Value2", dataType: "UINT16", bitSize: 16, bitOffset: 16 },
        ],
      },
    },
  });

  const result = resolveSlaves(config);
  assertEquals(result[0]!.variables.length, 2);
  assertEquals(result[0]!.variables[0]!.isInput, true);
  assertEquals(result[0]!.variables[1]!.name, "Value2");
});

Deno.test("resolveSlaves - enriches with SDO index from processData.entries", () => {
  const config = baseConfig({
    slaves: [
      {
        name: "EL3062",
        processData: {
          inputOffset: 0,
          inputBitLength: 32,
          entries: [
            {
              name: "Value1",
              index: 0x6000,
              subIndex: 1,
              bitLen: 16,
              dataType: "UINT16",
              pdoOffset: 0,
              pdiOffset: 0,
            },
            {
              name: "Value2",
              index: 0x6010,
              subIndex: 1,
              bitLen: 16,
              dataType: "UINT16",
              pdoOffset: 2,
              pdiOffset: 2,
            },
          ],
        },
      },
    ],
    processImage: {
      outputs: { byteSize: 0, variables: [] },
      inputs: {
        byteSize: 4,
        variables: [
          { name: "EL3062.Value1", dataType: "UINT16", bitSize: 16, bitOffset: 0 },
          { name: "EL3062.Value2", dataType: "UINT16", bitSize: 16, bitOffset: 16 },
        ],
      },
    },
  });

  const result = resolveSlaves(config);
  assertEquals(result[0]!.variables[0]!.sdoIndex, 0x6000);
  assertEquals(result[0]!.variables[0]!.sdoSubIndex, 1);
  assertEquals(result[0]!.variables[1]!.sdoIndex, 0x6010);
  assertEquals(result[0]!.variables[1]!.sdoSubIndex, 1);
});

Deno.test("resolveSlaves - no SDO info when processData.entries missing", () => {
  const config = baseConfig({
    slaves: [{ name: "EL2008" }],
    processImage: {
      outputs: {
        byteSize: 1,
        variables: [
          { name: "EL2008.Output_PDO_0", dataType: "BOOL", bitSize: 1, bitOffset: 0 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  });

  const result = resolveSlaves(config);
  assertEquals(result[0]!.variables[0]!.sdoIndex, undefined);
  assertEquals(result[0]!.variables[0]!.sdoSubIndex, undefined);
});

Deno.test("resolveSlaves - skips variables without dot separator", () => {
  const config = baseConfig({
    slaves: [{ name: "EL2008" }],
    processImage: {
      outputs: {
        byteSize: 1,
        variables: [
          { name: "Pump1_Run", dataType: "BOOL", bitSize: 1, bitOffset: 0 },
        ],
      },
      inputs: { byteSize: 0, variables: [] },
    },
  });

  const result = resolveSlaves(config);
  assertEquals(result[0]!.variables.length, 0);
});

Deno.test("resolveSlaves - preserves slave metadata", () => {
  const config = baseConfig({
    slaves: [
      { name: "EL2008", physAddr: 4103, vendorId: 2, productCode: 131608658 },
    ],
  });

  const result = resolveSlaves(config);
  assertEquals(result[0]!.physAddr, 4103);
  assertEquals(result[0]!.vendorId, 2);
  assertEquals(result[0]!.productCode, 131608658);
  assertEquals(result[0]!.index, 0);
});

Deno.test("resolveSlaves - handles missing processImage", () => {
  const config = baseConfig({
    slaves: [{ name: "EL2008" }],
  });

  const result = resolveSlaves(config);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.variables.length, 0);
});

Deno.test("resolveSlaves - multi-slave real-world scenario", () => {
  const config = baseConfig({
    slaves: [
      { name: "EK1100", vendorId: 2, productCode: 72100946 },
      { name: "XI211208", vendorId: 36, productCode: 2370049 },
      { name: "EL2008", vendorId: 2, productCode: 131608658 },
      { name: "EL3062", vendorId: 2, productCode: 200683602 },
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
      inputs: {
        byteSize: 4,
        variables: [
          { name: "EL3062.Value1", dataType: "UINT16", bitSize: 16, bitOffset: 0 },
        ],
      },
    },
  });

  const result = resolveSlaves(config);
  assertEquals(result.length, 4);

  // EK1100 — coupler, no variables
  assertEquals(result[0]!.variables.length, 0);

  // XI211208 — 2 outputs
  assertEquals(result[1]!.variables.length, 2);
  assertEquals(result[1]!.variables[0]!.isInput, false);

  // EL2008 — 1 output
  assertEquals(result[2]!.variables.length, 1);
  assertEquals(result[2]!.variables[0]!.name, "Output_PDO_0");

  // EL3062 — 1 input
  assertEquals(result[3]!.variables.length, 1);
  assertEquals(result[3]!.variables[0]!.isInput, true);
  assertEquals(result[3]!.variables[0]!.name, "Value1");
});

// --- findSlaveIndex tests ---

Deno.test("findSlaveIndex - finds slave by name", () => {
  const config = baseConfig({
    slaves: [
      { name: "EK1100" },
      { name: "EL2008" },
      { name: "EL3062" },
    ],
  });

  assertEquals(findSlaveIndex(config, "EK1100"), 0);
  assertEquals(findSlaveIndex(config, "EL2008"), 1);
  assertEquals(findSlaveIndex(config, "EL3062"), 2);
});

Deno.test("findSlaveIndex - returns -1 for unknown slave", () => {
  const config = baseConfig({
    slaves: [{ name: "EL2008" }],
  });

  assertEquals(findSlaveIndex(config, "UNKNOWN"), -1);
});

Deno.test("findSlaveIndex - returns first match for duplicate names", () => {
  const config = baseConfig({
    slaves: [
      { name: "EK1100", physAddr: 4100 },
      { name: "EL2008" },
      { name: "EK1100", physAddr: 4102 },
    ],
  });

  assertEquals(findSlaveIndex(config, "EK1100"), 0);
});
