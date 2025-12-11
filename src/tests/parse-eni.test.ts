import { assertEquals, assertExists } from "@std/assert";
import { parseEniXml } from "../utils/parse-eni.ts";

Deno.test("parseEniXml - parses basic ENI XML structure", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  assertExists(config);
  assertEquals(config.master.cycleTime, 1000);
  assertEquals(config.slaves.length, 2);
});

Deno.test("parseEniXml - extracts slave information correctly", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  const slave1 = config.slaves[0]!;
  assertExists(slave1);
  assertEquals(slave1.name, "Slave_1");
  assertEquals(slave1.vendorId, 0x00000002);
  assertEquals(slave1.productCode, 0x044c2c52);
  assertEquals(slave1.revisionNumber, 0x00112233);
  assertEquals(slave1.serialNumber, 0x00000001);
  assertEquals(slave1.physAddr, 1001);

  const slave2 = config.slaves[1]!;
  assertExists(slave2);
  assertEquals(slave2.name, "Slave_2");
  assertEquals(slave2.vendorId, 0x00000002);
  assertEquals(slave2.productCode, 0x07d43052);
});

Deno.test("parseEniXml - calculates PDI offsets correctly", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  const slave1 = config.slaves[0]!;
  assertExists(slave1);
  assertExists(slave1.processData);
  // Recv: BitStart 0 -> 0 bytes
  // Send: BitStart 0 -> 0 bytes
  assertEquals(slave1.processData.inputOffset, 0);
  assertEquals(slave1.processData.outputOffset, 0);

  const slave2 = config.slaves[1]!;
  assertExists(slave2);
  assertExists(slave2.processData);
  // Recv: BitStart 8 -> 1 byte
  assertEquals(slave2.processData.inputOffset, 1);
});

Deno.test("parseEniXml - generates ProcessData mappings correctly", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  assertExists(config.processData);
  assertExists(config.processData.mappings);

  const mapping1 = config.processData.mappings.find(
    (m) => m.variableName === "Slave_1.Input_Var",
  );
  assertExists(mapping1);
  // CRITICAL: PDI buffer layout is [Outputs | Inputs]
  // Outputs.ByteSize = 1, Input BitOffs = 0 (relative to Input section)
  // Absolute pdiByteOffset = 1 + (0 / 8) = 1
  assertEquals(mapping1.pdiByteOffset, 1);
  assertEquals(mapping1.dataType, "BYTE");
  assertEquals(mapping1.slaveIndex, 1);

  const mapping2 = config.processData.mappings.find(
    (m) => m.variableName === "Slave_1.Output_Var",
  );
  assertExists(mapping2);
  // Outputs start at 0, BitOffs = 0, so pdiByteOffset = 0 / 8 = 0
  assertEquals(mapping2.pdiByteOffset, 0);

  const mapping3 = config.processData.mappings.find(
    (m) => m.variableName === "Slave_2.Input_Var_A",
  );
  assertExists(mapping3);
  // Input BitOffs = 8 (relative to Input section)
  // Absolute pdiByteOffset = 1 + (8 / 8) = 2
  assertEquals(mapping3.pdiByteOffset, 2);
  assertEquals(mapping3.dataType, "INT");
});

Deno.test("parseEniXml - handles BOOL types with bitOffset", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  const boolMapping = config.processData?.mappings.find(
    (m) => m.variableName === "Slave_2.Input_Bool",
  );
  assertExists(boolMapping);
  assertEquals(boolMapping.dataType, "BOOL");
  // bitOffset should be set for BOOL types
  assertExists(boolMapping.bitOffset);
  // Input BitOffs = 24 (relative to Input section). 24 % 8 = 0.
  assertEquals(boolMapping.bitOffset, 0);
  // CRITICAL: PDI buffer layout is [Outputs | Inputs]
  // Outputs.ByteSize = 1, Input BitOffs = 24
  // Absolute pdiByteOffset = 1 + (24 / 8) = 4
  assertEquals(boolMapping.pdiByteOffset, 4);
});

Deno.test("parseEniXml - preserves InitCmds order", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  const slave1 = config.slaves[0]!;
  assertExists(slave1);
  assertExists(slave1.initCommands);
  assertEquals(slave1.initCommands.length, 2);

  const cmd1 = slave1.initCommands[0]!;
  assertExists(cmd1);
  assertEquals(cmd1.type, "register");
  assertEquals(cmd1.ado, 0x1000);
  assertEquals(cmd1.slaveIndex, 0);

  const cmd2 = slave1.initCommands[1]!;
  assertExists(cmd2);
  assertEquals(cmd2.type, "register");
  assertEquals(cmd2.ado, 0x1001);
  assertEquals(cmd2.slaveIndex, 0);
});

Deno.test("parseEniXml - calculates process data sizes correctly", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  assertExists(config.processData);
  // Input:
  // Slave 1: 8 bits.
  // Slave 2: 17 bits (16 INT + 1 BOOL) at offset 8. Ends at 8+17 = 25.
  // ProcessImage says 4 bytes (32 bits).
  // Let's check what the parser does.
  // The parser takes max(processImage.inputs.byteSize, totalInputBits/8).
  // XML says ByteSize 4.
  assertEquals(config.processData.inputSize, 4);

  // Output:
  // Slave 1: 8 bits.
  // XML says ByteSize 1.
  assertEquals(config.processData.outputSize, 1);
});

Deno.test("parseEniXml - extracts Mailbox Polling configuration", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");
  const slave1 = config.slaves[0]!;
  assertExists(slave1.pollTime);
  assertEquals(slave1.pollTime, 100);
});

Deno.test("parseEniXml - extracts Cyclic Process Data configuration", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  assertExists(config.cyclic);
  assertEquals(config.cyclic.cycleTime, 1000);

  const tasks = config.cyclic.tasks;
  assertExists(tasks);
  assertEquals(tasks.length, 1);

  const frames = tasks[0]!.frames;
  assertExists(frames);

  const cmds = frames[0]!.cmds;
  assertExists(cmds);
  assertEquals(cmds.length, 1);

  const cmd = cmds[0]!;
  assertEquals(cmd.cmd, 7);
  assertEquals(cmd.dataLength, 2);
  assertEquals(cmd.inputOffset, 60);
  assertEquals(cmd.outputOffset, 60);
});

Deno.test("parseEniXml - extracts Slave-to-Slave CopyInfos", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");

  const cmds = config.cyclic?.tasks?.[0]?.frames?.[0]?.cmds;
  assertExists(cmds);

  const cmd = cmds[0]!;
  assertExists(cmd.copyInfos);
  assertEquals(cmd.copyInfos.length, 1);

  const copyInfo = cmd.copyInfos[0]!;
  assertEquals(copyInfo.srcBitOffset, 0);
  assertEquals(copyInfo.dstBitOffset, 8);
  assertEquals(copyInfo.bitSize, 8);
});

Deno.test("parseEniXml - verifies InitCmd transitions", async () => {
  const config = await parseEniXml("./src/tests/fixtures/compliant.eni.xml");
  const slave1 = config.slaves[0]!;

  const initCmds = slave1.initCommands;
  assertExists(initCmds);

  const ipCmd = initCmds.find((c) => c.transition?.includes("IP"));
  assertExists(ipCmd);

  const psCmd = initCmds.find((c) => c.transition?.includes("PS"));
  assertExists(psCmd);
});

Deno.test("parseEniXml - throws error on invalid XML", async () => {
  let error: Error | undefined;
  try {
    await parseEniXml("./src/tests/fixtures/nonexistent.eni.xml");
  } catch (e) {
    error = e as Error;
  }
  assertExists(error);
});

Deno.test("parseEniXml - throws error on missing Config", async () => {
  const invalidXml = `<?xml version="1.0"?><EtherCATConfig></EtherCATConfig>`;
  await Deno.writeTextFile("./src/tests/fixtures/invalid.eni.xml", invalidXml);

  let error: Error | undefined;
  try {
    await parseEniXml("./src/tests/fixtures/invalid.eni.xml");
  } catch (e) {
    error = e as Error;
  }
  assertExists(error);
  assertEquals(error.message, "Invalid ENI XML: Missing EtherCATConfig.Config");

  // Cleanup
  await Deno.remove("./src/tests/fixtures/invalid.eni.xml");
});

// ============================================================================
// Class B Compliance Tests: Protocol Support Detection (Feature 402/505)
// ============================================================================

Deno.test("parseEniXml - Test Case 1.1: Explicit <CoE> Element Detection", async () => {
  const config = await parseEniXml("./src/tests/fixtures/coe_slave.eni.xml");
  const slave = config.slaves[0]!;
  assertExists(slave);
  assertEquals(
    slave.supportsCoE,
    true,
    "slave.supportsCoE should be true when <CoE> element is present",
  );
});

Deno.test("parseEniXml - Test Case 1.2: Protocol Tag Detection", async () => {
  const config = await parseEniXml("./src/tests/fixtures/protocol_tag_only.eni.xml");
  const slave = config.slaves[0]!;
  assertExists(slave);
  assertEquals(
    slave.supportsCoE,
    true,
    "slave.supportsCoE should be true when <Protocol>CoE</Protocol> tag is present",
  );
});

Deno.test("parseEniXml - Test Case 1.3: Mailbox Configuration Extraction", async () => {
  const config = await parseEniXml("./src/tests/fixtures/protocol_tag_only.eni.xml");
  const slave = config.slaves[0]!;
  assertExists(slave);
  assertEquals(slave.mailboxStatusAddr, 2061, "mailboxStatusAddr should equal 2061 (0x080D)");
  assertEquals(slave.pollTime, 20, "pollTime should equal 20");
});

Deno.test("parseEniXml - Test Case 1.4: No Protocol Support", async () => {
  const config = await parseEniXml("./src/tests/fixtures/no_protocol.eni.xml");
  const slave = config.slaves[0]!;
  assertExists(slave);
  assertEquals(
    slave.supportsCoE,
    undefined,
    "slave.supportsCoE should be undefined when no CoE tags are present",
  );
  assertEquals(slave.supportsEoE, undefined, "slave.supportsEoE should be undefined");
  assertEquals(slave.supportsFoE, undefined, "slave.supportsFoE should be undefined");
});
