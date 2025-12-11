import { assert, assertEquals, assertExists } from "@std/assert";
import { parseEniXml } from "../parse-eni.ts";

// Helper to create temporary XML file for testing
async function createTempXml(content: string): Promise<string> {
  const tempPath = await Deno.makeTempFile({ suffix: ".eni.xml" });
  await Deno.writeTextFile(tempPath, content);
  return tempPath;
}

Deno.test("parseEniXml - throws error on missing Config", async () => {
  const xml = `<?xml version="1.0"?><EtherCATConfig></EtherCATConfig>`;
  const path = await createTempXml(xml);

  let error: Error | undefined;
  try {
    await parseEniXml(path);
  } catch (e) {
    error = e as Error;
  } finally {
    await Deno.remove(path);
  }

  assertExists(error);
  assertEquals(error.message, "Invalid ENI XML: Missing EtherCATConfig.Config");
});

Deno.test("parseEniXml - parses minimal valid XML", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config);
    assertEquals(config.master.cycleTime, 1000);
    assertEquals(config.slaves.length, 0);
    assertEquals(config.interface, "");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses master info correctly", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <Info>
        <Name>TestMaster</Name>
        <Destination>00:11:22:33:44:55</Destination>
        <Source>AA:BB:CC:DD:EE:FF</Source>
        <EtherType>0x88A4</EtherType>
      </Info>
      <CycleTime>5000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.master.info);
    assertEquals(config.master.info.name, "TestMaster");
    assertEquals(config.master.info.destination, "00:11:22:33:44:55");
    assertEquals(config.master.info.source, "AA:BB:CC:DD:EE:FF");
    assertEquals(config.master.info.etherType, "0x88A4");
    assertEquals(config.master.cycleTime, 5000);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses master mailbox states", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <MailboxStates>
        <StartAddr>0x1000</StartAddr>
        <Count>8</Count>
      </MailboxStates>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.master.mailboxStates);
    assertEquals(config.master.mailboxStates.startAddr, 0x1000);
    assertEquals(config.master.mailboxStates.count, 8);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses master DC support", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <DcSupport>true</DcSupport>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertEquals(config.master.dcSupport, true);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses DC support as false", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <DcSupport>false</DcSupport>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertEquals(config.master.dcSupport, false);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses master init commands (register type)", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <InitCmds>
        <InitCmd>
          <Transition>IP</Transition>
          <Cmd>2</Cmd>
          <Adp>0</Adp>
          <Ado>0x1000</Ado>
          <Data>0x1234</Data>
        </InitCmd>
      </InitCmds>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.master.initCommands);
    assertEquals(config.master.initCommands.length, 1);
    const cmd = config.master.initCommands[0]!;
    assertEquals(cmd.type, "register");
    assertEquals(cmd.transition, ["IP"]);
    assertEquals(cmd.cmd, 2);
    assertEquals(cmd.adp, 0);
    assertEquals(cmd.ado, 0x1000);
    assertEquals(cmd.data, "0x1234");
    assertEquals(cmd.value, "0x1234");
    assertEquals(cmd.slaveIndex, -1);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses master init commands (SDO type)", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <InitCmds>
        <InitCmd>
          <Transition>PS</Transition>
          <Index>0x1000</Index>
          <SubIndex>0</SubIndex>
          <Data>0x5678</Data>
        </InitCmd>
      </InitCmds>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.master.initCommands);
    assertEquals(config.master.initCommands.length, 1);
    const cmd = config.master.initCommands[0]!;
    assertEquals(cmd.type, "sdo");
    assertEquals(cmd.index, 0x1000);
    assertEquals(cmd.subIndex, 0);
    assertEquals(cmd.value, "0x5678");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses master init commands (SoE type)", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <InitCmds>
        <InitCmd>
          <Transition>PS</Transition>
          <OpCode>1</OpCode>
          <DriveNo>0</DriveNo>
          <IDN>0x0001</IDN>
        </InitCmd>
      </InitCmds>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.master.initCommands);
    assertEquals(config.master.initCommands.length, 1);
    const cmd = config.master.initCommands[0]!;
    assertEquals(cmd.type, "soe");
    assertEquals(cmd.opCode, 1);
    assertEquals(cmd.driveNo, 0);
    assertEquals(cmd.idn, 0x0001);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses init command with multiple transitions", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <InitCmds>
        <InitCmd>
          <Transition>IP</Transition>
          <Transition>PS</Transition>
          <Cmd>2</Cmd>
          <Ado>0x1000</Ado>
        </InitCmd>
      </InitCmds>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const cmd = config.master.initCommands?.[0];
    assertExists(cmd);
    assertEquals(cmd.transition, ["IP", "PS"]);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses init command with validation", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master>
      <InitCmds>
        <InitCmd>
          <Transition>PS</Transition>
          <Cmd>2</Cmd>
          <Ado>0x1000</Ado>
          <Validate>
            <Data>0x1234</Data>
            <DataMask>0xFFFF</DataMask>
            <Timeout>1000</Timeout>
          </Validate>
        </InitCmd>
      </InitCmds>
      <CycleTime>1000</CycleTime>
    </Master>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const cmd = config.master.initCommands?.[0];
    assertExists(cmd);
    assertExists(cmd.validate);
    assertEquals(cmd.validate.data, "0x1234");
    assertEquals(cmd.validate.dataMask, "0xFFFF");
    assertEquals(cmd.validate.timeout, 1000);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses slave info correctly", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info>
        <Name>TestSlave</Name>
        <PhysAddr>1001</PhysAddr>
        <AutoIncAddr>0x0001</AutoIncAddr>
        <VendorId>0x00000002</VendorId>
        <ProductCode>0x044c2c52</ProductCode>
        <RevisionNo>0x00112233</RevisionNo>
        <SerialNo>0x00000001</SerialNo>
      </Info>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertEquals(config.slaves.length, 1);
    const slave = config.slaves[0]!;
    assertEquals(slave.name, "TestSlave");
    assertEquals(slave.physAddr, 1001);
    assertEquals(slave.autoIncAddr, 0x0001);
    assertEquals(slave.vendorId, 0x00000002);
    assertEquals(slave.productCode, 0x044c2c52);
    assertEquals(slave.revisionNumber, 0x00112233);
    assertEquals(slave.serialNumber, 0x00000001);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - generates default slave name when missing", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info>
        <PhysAddr>1001</PhysAddr>
      </Info>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertEquals(slave.name, "Slave_1");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses slave process data (standard Recv/Send format)", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv>
          <BitStart>0</BitStart>
          <BitLength>8</BitLength>
        </Recv>
        <Send>
          <BitStart>0</BitStart>
          <BitLength>16</BitLength>
        </Send>
      </ProcessData>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertExists(slave.processData);
    assertEquals(slave.processData.inputOffset, 0); // 0 bits / 8 = 0 bytes
    assertEquals(slave.processData.inputBitLength, 8);
    assertEquals(slave.processData.outputOffset, 0); // 0 bits / 8 = 0 bytes
    assertEquals(slave.processData.outputBitLength, 16);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses slave process data with bit offsets", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv>
          <BitStart>16</BitStart>
          <BitLength>8</BitLength>
        </Recv>
        <Send>
          <BitStart>8</BitStart>
          <BitLength>8</BitLength>
        </Send>
      </ProcessData>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertExists(slave.processData);
    assertEquals(slave.processData.inputOffset, 2); // 16 bits / 8 = 2 bytes
    assertEquals(slave.processData.outputOffset, 1); // 8 bits / 8 = 1 byte
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses slave process data (legacy Input/Output format)", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Input>
          <Offs>0</Offs>
          <Data>
            <Name>InputVar</Name>
            <Index>0x6000</Index>
            <SubIndex>1</SubIndex>
            <BitLen>8</BitLen>
            <DataType>BYTE</DataType>
            <PdoOffset>0</PdoOffset>
          </Data>
        </Input>
        <Output>
          <Offs>0</Offs>
          <Data>
            <Name>OutputVar</Name>
            <Index>0x7000</Index>
            <SubIndex>1</SubIndex>
            <BitLen>16</BitLen>
            <DataType>UINT16</DataType>
            <PdoOffset>0</PdoOffset>
          </Data>
        </Output>
      </ProcessData>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertExists(slave.processData);
    assertExists(slave.processData.entries);
    assertEquals(slave.processData.entries.length, 2);

    const inputEntry = slave.processData.entries.find((e) => e.name === "InputVar");
    assertExists(inputEntry);
    assertEquals(inputEntry.index, 0x6000);
    assertEquals(inputEntry.subIndex, 1);
    assertEquals(inputEntry.bitLen, 8);
    assertEquals(inputEntry.dataType, "BYTE");
    assertEquals(inputEntry.pdoOffset, 0);
    assertEquals(inputEntry.pdiOffset, 0); // (0 + 0) / 8 = 0

    const outputEntry = slave.processData.entries.find((e) => e.name === "OutputVar");
    assertExists(outputEntry);
    assertEquals(outputEntry.index, 0x7000);
    assertEquals(outputEntry.bitLen, 16);
    assertEquals(outputEntry.dataType, "UINT16");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - generates legacy format mappings correctly", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Input>
          <Offs>0</Offs>
          <Data>
            <Name>InputVar</Name>
            <Index>0x6000</Index>
            <SubIndex>1</SubIndex>
            <BitLen>8</BitLen>
            <DataType>BYTE</DataType>
            <PdoOffset>0</PdoOffset>
          </Data>
        </Input>
      </ProcessData>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.processData);
    assertExists(config.processData.mappings);
    const mapping = config.processData.mappings.find(
      (m) => m.variableName === "Slave_1.InputVar",
    );
    assertExists(mapping);
    assertEquals(mapping.slaveIndex, 1);
    assertEquals(mapping.isInput, true);
    assertEquals(mapping.dataType, "BYTE");
    assertEquals(mapping.bitSize, 8);
    assertEquals(mapping.pdiByteOffset, 0);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses slave mailbox configuration", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <Mailbox>
        <Recv>
          <StatusBitAddr>0x80D</StatusBitAddr>
          <PollTime>100</PollTime>
        </Recv>
      </Mailbox>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertEquals(slave.mailboxStatusAddr, 0x80D);
    assertEquals(slave.pollTime, 100);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses slave previous port", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <PreviousPort>
        <Port>A</Port>
        <PhysAddr>1000</PhysAddr>
      </PreviousPort>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertExists(slave.previousPort);
    assertEquals(slave.previousPort.port, "A");
    assertEquals(slave.previousPort.physAddr, 1000);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses slave init commands", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <InitCmds>
        <InitCmd>
          <Transition>IP</Transition>
          <Cmd>2</Cmd>
          <Ado>0x1000</Ado>
          <Data>0x1234</Data>
        </InitCmd>
      </InitCmds>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertExists(slave.initCommands);
    assertEquals(slave.initCommands.length, 1);
    const cmd = slave.initCommands[0]!;
    assertEquals(cmd.type, "register");
    assertEquals(cmd.slaveIndex, 0);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses multiple slaves", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
    </Slave>
    <Slave>
      <Info><PhysAddr>1002</PhysAddr></Info>
    </Slave>
    <Slave>
      <Info><PhysAddr>1003</PhysAddr></Info>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertEquals(config.slaves.length, 3);
    assertEquals(config.slaves[0]!.physAddr, 1001);
    assertEquals(config.slaves[1]!.physAddr, 1002);
    assertEquals(config.slaves[2]!.physAddr, 1003);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses cyclic configuration", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Cyclic>
      <CycleTime>2000</CycleTime>
      <Frame>
        <Cmd>
          <Cmd>7</Cmd>
          <Addr>0</Addr>
          <DataLength>2</DataLength>
          <InputOffs>0</InputOffs>
          <OutputOffs>0</OutputOffs>
          <Cnt>2</Cnt>
        </Cmd>
      </Frame>
    </Cyclic>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.cyclic);
    assertEquals(config.cyclic.cycleTime, 2000);
    assertExists(config.cyclic.tasks);
    assertEquals(config.cyclic.tasks.length, 1);
    const task = config.cyclic.tasks[0]!;
    assertEquals(task.cycleTime, 2000);
    assertEquals(task.frames.length, 1);
    const frame = task.frames[0]!;
    assertEquals(frame.cmds.length, 1);
    const cmd = frame.cmds[0]!;
    assertEquals(cmd.cmd, 7);
    assertEquals(cmd.addr, 0);
    assertEquals(cmd.dataLength, 2);
    assertEquals(cmd.inputOffset, 0);
    assertEquals(cmd.outputOffset, 0);
    assertEquals(cmd.cnt, 2);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses cyclic copyInfos", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Cyclic>
      <CycleTime>1000</CycleTime>
      <Frame>
        <Cmd>
          <Cmd>7</Cmd>
          <Addr>0</Addr>
          <DataLength>2</DataLength>
          <InputOffs>0</InputOffs>
          <OutputOffs>0</OutputOffs>
          <Cnt>2</Cnt>
          <CopyInfos>
            <CopyInfo>
              <SrcBitOffs>0</SrcBitOffs>
              <DstBitOffs>8</DstBitOffs>
              <BitSize>8</BitSize>
            </CopyInfo>
          </CopyInfos>
        </Cmd>
      </Frame>
    </Cyclic>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const cmd = config.cyclic?.tasks?.[0]?.frames?.[0]?.cmds?.[0];
    assertExists(cmd);
    assertExists(cmd.copyInfos);
    assertEquals(cmd.copyInfos.length, 1);
    const copyInfo = cmd.copyInfos[0]!;
    assertEquals(copyInfo.srcBitOffset, 0);
    assertEquals(cmd.copyInfos[0]!.dstBitOffset, 8);
    assertEquals(cmd.copyInfos[0]!.bitSize, 8);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses process image inputs and outputs", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv><BitStart>0</BitStart><BitLength>8</BitLength></Recv>
        <Send><BitStart>0</BitStart><BitLength>8</BitLength></Send>
      </ProcessData>
    </Slave>
    <ProcessImage>
      <Inputs>
        <ByteSize>1</ByteSize>
        <Variable>
          <Name>InputVar</Name>
          <DataType>BYTE</DataType>
          <BitSize>8</BitSize>
          <BitOffs>0</BitOffs>
        </Variable>
      </Inputs>
      <Outputs>
        <ByteSize>1</ByteSize>
        <Variable>
          <Name>OutputVar</Name>
          <DataType>BYTE</DataType>
          <BitSize>8</BitSize>
          <BitOffs>0</BitOffs>
        </Variable>
      </Outputs>
    </ProcessImage>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.processImage);
    assertEquals(config.processImage.inputs.byteSize, 1);
    assertEquals(config.processImage.inputs.variables.length, 1);
    const inputVar = config.processImage.inputs.variables[0]!;
    assertEquals(inputVar.name, "InputVar");
    assertEquals(inputVar.dataType, "BYTE");
    assertEquals(inputVar.bitSize, 8);
    assertEquals(inputVar.bitOffset, 0);

    assertEquals(config.processImage.outputs.byteSize, 1);
    assertEquals(config.processImage.outputs.variables.length, 1);
    const outputVar = config.processImage.outputs.variables[0]!;
    assertEquals(outputVar.name, "OutputVar");
    assertEquals(outputVar.dataType, "BYTE");
    assertEquals(outputVar.bitSize, 8);
    assertEquals(outputVar.bitOffset, 0);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - generates process data mappings from ProcessImage", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv><BitStart>0</BitStart><BitLength>8</BitLength></Recv>
        <Send><BitStart>0</BitStart><BitLength>8</BitLength></Send>
      </ProcessData>
    </Slave>
    <ProcessImage>
      <Inputs>
        <ByteSize>1</ByteSize>
        <Variable>
          <Name>InputVar</Name>
          <DataType>BYTE</DataType>
          <BitSize>8</BitSize>
          <BitOffs>0</BitOffs>
        </Variable>
      </Inputs>
      <Outputs>
        <ByteSize>1</ByteSize>
        <Variable>
          <Name>OutputVar</Name>
          <DataType>BYTE</DataType>
          <BitSize>8</BitSize>
          <BitOffs>0</BitOffs>
        </Variable>
      </Outputs>
    </ProcessImage>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.processData);
    assertExists(config.processData.mappings);
    // Should have mappings for both input and output variables
    assertEquals(config.processData.mappings.length, 2);

    const inputMapping = config.processData.mappings.find((m) => m.variableName === "InputVar");
    assertExists(inputMapping);
    assertEquals(inputMapping.isInput, true);
    assertEquals(inputMapping.slaveIndex, 1);
    // PDI layout: [Outputs | Inputs], so input offset = outputSize (1) + 0 = 1
    assertEquals(inputMapping.pdiByteOffset, 1);

    const outputMapping = config.processData.mappings.find((m) => m.variableName === "OutputVar");
    assertExists(outputMapping);
    assertEquals(outputMapping.isInput, false);
    assertEquals(outputMapping.slaveIndex, 1);
    assertEquals(outputMapping.pdiByteOffset, 0);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles BOOL type with bitOffset in ProcessImage", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv><BitStart>0</BitStart><BitLength>8</BitLength></Recv>
      </ProcessData>
    </Slave>
    <ProcessImage>
      <Inputs>
        <ByteSize>1</ByteSize>
        <Variable>
          <Name>BoolVar</Name>
          <DataType>BOOL</DataType>
          <BitSize>1</BitSize>
          <BitOffs>5</BitOffs>
        </Variable>
      </Inputs>
      <Outputs><ByteSize>0</ByteSize></Outputs>
    </ProcessImage>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const mapping = config.processData?.mappings.find((m) => m.variableName === "BoolVar");
    assertExists(mapping);
    assertEquals(mapping.dataType, "BOOL");
    assertExists(mapping.bitOffset);
    assertEquals(mapping.bitOffset, 5);
    assertEquals(mapping.pdiByteOffset, 0); // Output size is 0, so input starts at 0
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses hex values correctly (0x prefix)", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info>
        <PhysAddr>0x03E9</PhysAddr>
        <VendorId>0x00000002</VendorId>
      </Info>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertEquals(slave.physAddr, 0x03E9); // 1001 in decimal
    assertEquals(slave.vendorId, 0x00000002);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses hex values without prefix", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info>
        <VendorId>00000002</VendorId>
      </Info>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertEquals(slave.vendorId, 0x00000002);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - parses decimal values", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info>
        <PhysAddr>1001</PhysAddr>
      </Info>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertEquals(slave.physAddr, 1001);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles missing optional fields gracefully", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info></Info>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertEquals(slave.name, "Slave_1");
    assertEquals(slave.vendorId, undefined);
    assertEquals(slave.productCode, undefined);
    assertEquals(slave.processData, undefined);
    // parseInitCmds returns empty array when no commands, not undefined
    assertEquals(slave.initCommands, []);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles empty ProcessImage", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <ProcessImage>
      <Inputs><ByteSize>0</ByteSize></Inputs>
      <Outputs><ByteSize>0</ByteSize></Outputs>
    </ProcessImage>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.processImage);
    assertEquals(config.processImage.inputs.byteSize, 0);
    assertEquals(config.processImage.inputs.variables.length, 0);
    assertEquals(config.processImage.outputs.byteSize, 0);
    assertEquals(config.processImage.outputs.variables.length, 0);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles multiple variables in ProcessImage", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv><BitStart>0</BitStart><BitLength>32</BitLength></Recv>
        <Send><BitStart>0</BitStart><BitLength>32</BitLength></Send>
      </ProcessData>
    </Slave>
    <ProcessImage>
      <Inputs>
        <ByteSize>4</ByteSize>
        <Variable>
          <Name>Input1</Name>
          <DataType>UINT16</DataType>
          <BitSize>16</BitSize>
          <BitOffs>0</BitOffs>
        </Variable>
        <Variable>
          <Name>Input2</Name>
          <DataType>UINT16</DataType>
          <BitSize>16</BitSize>
          <BitOffs>16</BitOffs>
        </Variable>
      </Inputs>
      <Outputs>
        <ByteSize>4</ByteSize>
        <Variable>
          <Name>Output1</Name>
          <DataType>UINT16</DataType>
          <BitSize>16</BitSize>
          <BitOffs>0</BitOffs>
        </Variable>
        <Variable>
          <Name>Output2</Name>
          <DataType>UINT16</DataType>
          <BitSize>16</BitSize>
          <BitOffs>16</BitOffs>
        </Variable>
      </Outputs>
    </ProcessImage>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertEquals(config.processImage!.inputs.variables.length, 2);
    assertEquals(config.processImage!.outputs.variables.length, 2);
    assertEquals(config.processData!.mappings.length, 4);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles legacy format with multiple Data entries", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Input>
          <Offs>0</Offs>
          <Data>
            <Name>Input1</Name>
            <Index>0x6000</Index>
            <SubIndex>1</SubIndex>
            <BitLen>8</BitLen>
            <DataType>BYTE</DataType>
            <PdoOffset>0</PdoOffset>
          </Data>
          <Data>
            <Name>Input2</Name>
            <Index>0x6001</Index>
            <SubIndex>1</SubIndex>
            <BitLen>8</BitLen>
            <DataType>BYTE</DataType>
            <PdoOffset>8</PdoOffset>
          </Data>
        </Input>
      </ProcessData>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertExists(slave.processData);
    assertExists(slave.processData.entries);
    assertEquals(slave.processData.entries.length, 2);
    assertEquals(slave.processData.entries[0]!.name, "Input1");
    assertEquals(slave.processData.entries[1]!.name, "Input2");
    // Should calculate inputBitLength from entries
    assertExists(slave.processData.inputBitLength);
    assertEquals(slave.processData.inputBitLength, 16); // 8 + 8
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - calculates process data sizes from bit lengths", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv><BitStart>0</BitStart><BitLength>17</BitLength></Recv>
        <Send><BitStart>0</BitStart><BitLength>9</BitLength></Send>
      </ProcessData>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.processData);
    // 17 bits = 3 bytes (ceil(17/8) = 3)
    assertEquals(config.processData.inputSize, 3);
    // 9 bits = 2 bytes (ceil(9/8) = 2)
    assertEquals(config.processData.outputSize, 2);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - prefers ProcessImage byteSize over calculated sizes", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv><BitStart>0</BitStart><BitLength>8</BitLength></Recv>
        <Send><BitStart>0</BitStart><BitLength>8</BitLength></Send>
      </ProcessData>
    </Slave>
    <ProcessImage>
      <Inputs><ByteSize>10</ByteSize></Inputs>
      <Outputs><ByteSize>5</ByteSize></Outputs>
    </ProcessImage>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    assertExists(config.processData);
    assertEquals(config.processData.inputSize, 10);
    assertEquals(config.processData.outputSize, 5);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles cyclic with multiple frames", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Cyclic>
      <CycleTime>1000</CycleTime>
      <Frame>
        <Cmd>
          <Cmd>7</Cmd>
          <Addr>0</Addr>
          <DataLength>2</DataLength>
          <InputOffs>0</InputOffs>
          <OutputOffs>0</OutputOffs>
          <Cnt>2</Cnt>
        </Cmd>
      </Frame>
      <Frame>
        <Cmd>
          <Cmd>10</Cmd>
          <Addr>1</Addr>
          <DataLength>4</DataLength>
          <InputOffs>2</InputOffs>
          <OutputOffs>2</OutputOffs>
          <Cnt>1</Cnt>
        </Cmd>
      </Frame>
    </Cyclic>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const task = config.cyclic?.tasks?.[0];
    assertExists(task);
    assertEquals(task.frames.length, 2);
    assertEquals(task.frames[0]!.cmds[0]!.cmd, 7);
    assertEquals(task.frames[1]!.cmds[0]!.cmd, 10);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles cyclic with multiple commands per frame", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Cyclic>
      <CycleTime>1000</CycleTime>
      <Frame>
        <Cmd>
          <Cmd>7</Cmd>
          <Addr>0</Addr>
          <DataLength>2</DataLength>
          <InputOffs>0</InputOffs>
          <OutputOffs>0</OutputOffs>
          <Cnt>2</Cnt>
        </Cmd>
        <Cmd>
          <Cmd>10</Cmd>
          <Addr>1</Addr>
          <DataLength>4</DataLength>
          <InputOffs>2</InputOffs>
          <OutputOffs>2</OutputOffs>
          <Cnt>1</Cnt>
        </Cmd>
      </Frame>
    </Cyclic>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const frame = config.cyclic?.tasks?.[0]?.frames?.[0];
    assertExists(frame);
    assertEquals(frame.cmds.length, 2);
    assertEquals(frame.cmds[0]!.cmd, 7);
    assertEquals(frame.cmds[1]!.cmd, 10);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles init command with requires field", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <InitCmds>
        <InitCmd>
          <Transition>PS</Transition>
          <Cmd>2</Cmd>
          <Ado>0x1000</Ado>
          <Requires>cycle</Requires>
        </InitCmd>
      </InitCmds>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const cmd = config.slaves[0]!.initCommands?.[0];
    assertExists(cmd);
    assertEquals(cmd.requires, "cycle");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles init command with retries and cnt", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <InitCmds>
        <InitCmd>
          <Transition>PS</Transition>
          <Cmd>2</Cmd>
          <Ado>0x1000</Ado>
          <Retries>3</Retries>
          <Cnt>1</Cnt>
        </InitCmd>
      </InitCmds>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const cmd = config.slaves[0]!.initCommands?.[0];
    assertExists(cmd);
    assertEquals(cmd.retries, 3);
    assertEquals(cmd.cnt, 1);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles process variable with comment", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv><BitStart>0</BitStart><BitLength>8</BitLength></Recv>
      </ProcessData>
    </Slave>
    <ProcessImage>
      <Inputs>
        <ByteSize>1</ByteSize>
        <Variable>
          <Name>InputVar</Name>
          <DataType>BYTE</DataType>
          <BitSize>8</BitSize>
          <BitOffs>0</BitOffs>
          <Comment>Test comment</Comment>
        </Variable>
      </Inputs>
      <Outputs><ByteSize>0</ByteSize></Outputs>
    </ProcessImage>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const variable = config.processImage!.inputs.variables[0]!;
    assertEquals(variable.comment, "Test comment");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles unknown init command type", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <InitCmds>
        <InitCmd>
          <Transition>PS</Transition>
          <Cmd>99</Cmd>
          <Ado>0x1000</Ado>
        </InitCmd>
      </InitCmds>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const cmd = config.slaves[0]!.initCommands?.[0];
    assertExists(cmd);
    assertEquals(cmd.type, "unknown");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles register command type (cmd 5)", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <InitCmds>
        <InitCmd>
          <Transition>PS</Transition>
          <Cmd>5</Cmd>
          <Ado>0x1000</Ado>
          <Data>0x1234</Data>
        </InitCmd>
      </InitCmds>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const cmd = config.slaves[0]!.initCommands?.[0];
    assertExists(cmd);
    assertEquals(cmd.type, "register");
    assertEquals(cmd.cmd, 5);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles legacy format with PdoOffset", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Input>
          <Offs>0</Offs>
          <Data>
            <Name>InputVar</Name>
            <Index>0x6000</Index>
            <SubIndex>1</SubIndex>
            <BitLen>8</BitLen>
            <DataType>BYTE</DataType>
            <PdoOffset>0x10</PdoOffset>
          </Data>
        </Input>
      </ProcessData>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const entry = config.slaves[0]!.processData!.entries![0]!;
    assertEquals(entry.pdoOffset, 0x10); // 16 in decimal
    // pdiOffset = (0 + 16) / 8 = 2
    assertEquals(entry.pdiOffset, 2);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles process data without BitStart (defaults to 0)", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Recv>
          <BitLength>8</BitLength>
        </Recv>
      </ProcessData>
    </Slave>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    const slave = config.slaves[0]!;
    assertExists(slave.processData);
    assertEquals(slave.processData.inputOffset, 0);
    assertEquals(slave.processData.inputBitLength, 8);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - handles cyclic array format", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Cyclic>
      <CycleTime>1000</CycleTime>
      <Frame>
        <Cmd>
          <Cmd>7</Cmd>
          <Addr>0</Addr>
          <DataLength>2</DataLength>
          <InputOffs>0</InputOffs>
          <OutputOffs>0</OutputOffs>
          <Cnt>2</Cnt>
        </Cmd>
      </Frame>
    </Cyclic>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    // Should handle both single and array formats
    assertExists(config.cyclic);
    assertExists(config.cyclic.tasks);
    assertEquals(config.cyclic.tasks.length, 1);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("parseEniXml - clears legacy mappings when ProcessImage exists", async () => {
  const xml = `<?xml version="1.0"?>
<EtherCATConfig>
  <Config>
    <Master><CycleTime>1000</CycleTime></Master>
    <Slave>
      <Info><PhysAddr>1001</PhysAddr></Info>
      <ProcessData>
        <Input>
          <Offs>0</Offs>
          <Data>
            <Name>LegacyVar</Name>
            <Index>0x6000</Index>
            <SubIndex>1</SubIndex>
            <BitLen>8</BitLen>
            <DataType>BYTE</DataType>
            <PdoOffset>0</PdoOffset>
          </Data>
        </Input>
      </ProcessData>
    </Slave>
    <ProcessImage>
      <Inputs>
        <ByteSize>1</ByteSize>
        <Variable>
          <Name>StandardVar</Name>
          <DataType>BYTE</DataType>
          <BitSize>8</BitSize>
          <BitOffs>0</BitOffs>
        </Variable>
      </Inputs>
      <Outputs><ByteSize>0</ByteSize></Outputs>
    </ProcessImage>
  </Config>
</EtherCATConfig>`;
  const path = await createTempXml(xml);

  try {
    const config = await parseEniXml(path);
    // Legacy mappings should be cleared, only standard ProcessImage mappings should exist
    const legacyMapping = config.processData!.mappings.find(
      (m) => m.variableName === "Slave_1.LegacyVar",
    );
    assert(!legacyMapping, "Legacy mapping should be cleared");

    const standardMapping = config.processData!.mappings.find(
      (m) => m.variableName === "StandardVar",
    );
    assertExists(standardMapping, "Standard mapping should exist");
  } finally {
    await Deno.remove(path);
  }
});
