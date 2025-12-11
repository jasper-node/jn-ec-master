import { XMLParser } from "fast-xml-parser";
import type {
  EniConfig,
  EniCyclicCmd,
  EniCyclicConfig,
  EniCyclicFrame,
  EniSlaveConfig,
  InitCommand,
  ProcessDataEntry,
  ProcessDataMapping,
  ProcessImage,
  ProcessVariable,
} from "../types/eni-config.ts";
import { buildProcessDataMappings } from "./process-data-mapper.ts";

// Helper interfaces for XML structure (matching XSD/XML roughly)
interface EniXmlStructure {
  EtherCATConfig?: {
    Config?: {
      Master?: {
        Info?: {
          Name?: string;
          Destination?: string;
          Source?: string;
          EtherType?: string;
        };
        MailboxStates?: {
          StartAddr?: string;
          Count?: string;
        };
        InitCmds?: {
          InitCmd?: EniInitCmd[] | EniInitCmd;
        };
        CycleTime?: string;
        DcSupport?: string;
      };
      Slave?: EniSlave[] | EniSlave;
      Cyclic?: {
        CycleTime?: string;
        Frame?: EniXmlFrame[] | EniXmlFrame;
      } | {
        CycleTime?: string;
        Frame?: EniXmlFrame[] | EniXmlFrame;
      }[];
      ProcessImage?: {
        Inputs?: {
          ByteSize?: string;
          Variable?: EniVariable[] | EniVariable;
        };
        Outputs?: {
          ByteSize?: string;
          Variable?: EniVariable[] | EniVariable;
        };
      };
    };
  };
}

interface EniXmlFrame {
  Cmd?: EniXmlCmd[] | EniXmlCmd;
}

interface EniXmlCmd {
  Cmd?: string;
  Addr?: string;
  Adp?: string;
  Ado?: string;
  DataLength?: string;
  InputOffs?: string;
  OutputOffs?: string;
  Cnt?: string;
  CopyInfos?: {
    CopyInfo?:
      | Array<{
        SrcBitOffs?: string;
        DstBitOffs?: string;
        BitSize?: string;
      }>
      | {
        SrcBitOffs?: string;
        DstBitOffs?: string;
        BitSize?: string;
      };
  };
}

interface EniSlave {
  Info?: {
    Name?: string;
    PhysAddr?: string;
    AutoIncAddr?: string;
    VendorId?: string;
    ProductCode?: string;
    RevisionNo?: string;
    SerialNo?: string;
  };
  Mailbox?: {
    Recv?: {
      StatusBitAddr?: string;
      PollTime?: string;
    };
    Protocol?: string | string[];
    CoE?: { Profile?: unknown };
    EoE?: unknown;
    FoE?: unknown;
  };
  ProcessData?: {
    Recv?: {
      BitStart?: string;
      BitLength?: string;
    };
    Send?: {
      BitStart?: string;
      BitLength?: string;
    };
    // Legacy support
    Input?: {
      Offs?: string;
      Data?: Array<{
        Name?: string;
        Index?: string;
        SubIndex?: string;
        BitLen?: string;
        DataType?: string;
        PdoOffset?: string;
      }>;
    };
    Output?: {
      Offs?: string;
      Data?: Array<{
        Name?: string;
        Index?: string;
        SubIndex?: string;
        BitLen?: string;
        DataType?: string;
        PdoOffset?: string;
      }>;
    };
  };
  InitCmds?: {
    InitCmd?: EniInitCmd[] | EniInitCmd;
  };
  PreviousPort?: {
    Port: string;
    PhysAddr: string;
  } | {
    Port: string;
    PhysAddr: string;
  }[];
}

interface EniInitCmd {
  Transition?: string | string[];
  Cmd?: string;
  Adp?: string;
  Ado?: string;
  Addr?: string;
  Data?: string;
  DataLength?: string;
  Cnt?: string;
  Retries?: string;
  Requires?: string;
  OpCode?: string;
  DriveNo?: string;
  IDN?: string;
  Validate?: {
    Data: string;
    DataMask?: string;
    Timeout?: string;
  };
  Type?: string;
  Index?: string;
  SubIndex?: string;
  Value?: string;
}

interface EniVariable {
  Name: string;
  DataType?: string;
  BitSize: string;
  BitOffs: string;
  Comment?: string;
}

export async function parseEniXml(xmlPath: string): Promise<EniConfig> {
  const xmlContent = await Deno.readTextFile(xmlPath);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "_text",
    parseAttributeValue: false,
    trimValues: true,
    parseTagValue: false,
  });

  const xmlData = parser.parse(xmlContent) as EniXmlStructure;

  if (!xmlData.EtherCATConfig?.Config) {
    throw new Error("Invalid ENI XML: Missing EtherCATConfig.Config");
  }

  const config = xmlData.EtherCATConfig.Config;

  const parseHex = (value: string | number | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      let result: number;
      if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
        result = parseInt(trimmed, 16);
      } else if (/^-?\d+$/.test(trimmed)) {
        result = parseInt(trimmed, 10);
      } else {
        const hexMatch = trimmed.match(/^[0-9a-fA-F]+$/);
        if (hexMatch) {
          result = parseInt(trimmed, 16);
        } else {
          result = parseInt(trimmed, 10);
        }
      }
      return isNaN(result) ? undefined : result;
    }
    return undefined;
  };

  const parseInitCmds = (
    cmds: EniInitCmd[] | EniInitCmd | undefined,
    slaveIndex: number,
  ): InitCommand[] => {
    if (!cmds) return [];
    const cmdArray = Array.isArray(cmds) ? cmds : [cmds];
    return cmdArray.map((cmd) => {
      const c: InitCommand = {
        type: "unknown",
        slaveIndex,
        transition: Array.isArray(cmd.Transition)
          ? cmd.Transition
          : (cmd.Transition ? [cmd.Transition] : undefined),
        cmd: parseHex(cmd.Cmd),
        adp: parseHex(cmd.Adp),
        ado: parseHex(cmd.Ado),
        addr: parseHex(cmd.Addr),
        data: cmd.Data,
        dataLength: parseHex(cmd.DataLength),
        cnt: parseHex(cmd.Cnt),
        retries: parseHex(cmd.Retries),
        requires: cmd.Requires as "cycle" | "frame" | undefined,
        opCode: parseHex(cmd.OpCode),
        driveNo: parseHex(cmd.DriveNo),
        idn: parseHex(cmd.IDN),
      };

      if (c.cmd === 2 || c.cmd === 5) {
        c.type = "register";
        c.value = c.data;
      } else if (cmd.Index !== undefined && cmd.SubIndex !== undefined) {
        c.type = "sdo";
        c.index = parseHex(cmd.Index);
        c.subIndex = parseHex(cmd.SubIndex);
        c.value = cmd.Data || cmd.Value;
      } else if (c.opCode !== undefined) {
        c.type = "soe";
      }

      if (cmd.Validate) {
        c.validate = {
          data: cmd.Validate.Data,
          dataMask: cmd.Validate.DataMask,
          timeout: parseHex(cmd.Validate.Timeout),
        };
      }

      return c;
    });
  };

  const masterXml = config.Master;
  const cyclicXml = config.Cyclic
    ? (Array.isArray(config.Cyclic) ? config.Cyclic[0] : config.Cyclic)
    : undefined;

  const master = {
    info: masterXml?.Info
      ? {
        name: masterXml.Info.Name || "Master",
        destination: masterXml.Info.Destination,
        source: masterXml.Info.Source,
        etherType: masterXml.Info.EtherType,
      }
      : undefined,
    mailboxStates: masterXml?.MailboxStates
      ? {
        startAddr: parseHex(masterXml.MailboxStates.StartAddr) || 0,
        count: parseHex(masterXml.MailboxStates.Count) || 0,
      }
      : undefined,
    initCommands: parseInitCmds(masterXml?.InitCmds?.InitCmd, -1),
    cycleTime: cyclicXml?.CycleTime
      ? parseInt(cyclicXml.CycleTime, 10)
      : (masterXml?.CycleTime ? parseInt(masterXml.CycleTime, 10) : undefined),
    dcSupport: typeof masterXml?.DcSupport === "string"
      ? masterXml.DcSupport.toLowerCase() === "true"
      : Boolean(masterXml?.DcSupport),
  };

  const slaves: EniSlaveConfig[] = [];
  const slaveArray = config.Slave
    ? (Array.isArray(config.Slave) ? config.Slave : [config.Slave])
    : [];

  // These track BITS
  let totalInputBits = 0;
  let totalOutputBits = 0;
  const mappings: ProcessDataMapping[] = [];

  slaveArray.forEach((slaveXml, slaveIndex) => {
    const slave: EniSlaveConfig = {
      name: slaveXml.Info?.Name || `Slave_${slaveIndex + 1}`,
      vendorId: parseHex(slaveXml.Info?.VendorId),
      productCode: parseHex(slaveXml.Info?.ProductCode),
      revisionNumber: parseHex(slaveXml.Info?.RevisionNo),
      serialNumber: parseHex(slaveXml.Info?.SerialNo),
      physAddr: parseHex(slaveXml.Info?.PhysAddr),
      autoIncAddr: parseHex(slaveXml.Info?.AutoIncAddr),
      initCommands: parseInitCmds(slaveXml.InitCmds?.InitCmd, slaveIndex),
    };

    if (slaveXml.PreviousPort) {
      const ports = Array.isArray(slaveXml.PreviousPort)
        ? slaveXml.PreviousPort
        : [slaveXml.PreviousPort];
      if (ports.length > 0 && ports[0]) {
        slave.previousPort = {
          port: ports[0].Port,
          physAddr: parseHex(ports[0].PhysAddr) || 0,
        };
      }
    }

    if (slaveXml.Mailbox?.Recv) {
      if (slaveXml.Mailbox.Recv.StatusBitAddr) {
        slave.mailboxStatusAddr = parseHex(slaveXml.Mailbox.Recv.StatusBitAddr);
      }
      if (slaveXml.Mailbox.Recv.PollTime) {
        slave.pollTime = parseHex(slaveXml.Mailbox.Recv.PollTime);
      }
    }

    // Explicit Protocol Detection
    if (slaveXml.Mailbox) {
      const protocols = Array.isArray(slaveXml.Mailbox.Protocol)
        ? slaveXml.Mailbox.Protocol
        : (slaveXml.Mailbox.Protocol ? [slaveXml.Mailbox.Protocol] : []);

      // Check Protocol Tag OR Element presence
      if (protocols.some((p) => p.toUpperCase() === "COE") || slaveXml.Mailbox.CoE !== undefined) {
        slave.supportsCoE = true;
      }
      if (protocols.some((p) => p.toUpperCase() === "EOE") || slaveXml.Mailbox.EoE !== undefined) {
        slave.supportsEoE = true;
      }
      if (protocols.some((p) => p.toUpperCase() === "FOE") || slaveXml.Mailbox.FoE !== undefined) {
        slave.supportsFoE = true;
      }
    }

    if (slaveXml.ProcessData) {
      const entries: ProcessDataEntry[] = [];
      let inputOffset = 0;
      let outputOffset = 0;
      let inputBitLength: number | undefined;
      let outputBitLength: number | undefined;

      // Handle standard Eni format (Recv/Send)
      if (slaveXml.ProcessData.Recv || slaveXml.ProcessData.Send) {
        if (slaveXml.ProcessData.Recv) {
          inputOffset = slaveXml.ProcessData.Recv.BitStart
            ? parseInt(slaveXml.ProcessData.Recv.BitStart, 10)
            : 0;
          inputBitLength = slaveXml.ProcessData.Recv.BitLength
            ? parseInt(slaveXml.ProcessData.Recv.BitLength, 10)
            : undefined;
          if (inputBitLength !== undefined && inputOffset + inputBitLength > totalInputBits) {
            totalInputBits = inputOffset + inputBitLength;
          }
        }

        if (slaveXml.ProcessData.Send) {
          outputOffset = slaveXml.ProcessData.Send.BitStart
            ? parseInt(slaveXml.ProcessData.Send.BitStart, 10)
            : 0;
          outputBitLength = slaveXml.ProcessData.Send.BitLength
            ? parseInt(slaveXml.ProcessData.Send.BitLength, 10)
            : undefined;
          if (outputBitLength !== undefined && outputOffset + outputBitLength > totalOutputBits) {
            totalOutputBits = outputOffset + outputBitLength;
          }
        }
      } // Handle legacy format (Input/Output with internal Data definitions)
      else {
        inputOffset = slaveXml.ProcessData.Input?.Offs
          ? parseInt(slaveXml.ProcessData.Input.Offs, 10)
          : totalInputBits;

        outputOffset = slaveXml.ProcessData.Output?.Offs
          ? parseInt(slaveXml.ProcessData.Output.Offs, 10)
          : totalOutputBits;

        // Legacy Inputs
        const inputs = slaveXml.ProcessData.Input?.Data
          ? (Array.isArray(slaveXml.ProcessData.Input.Data)
            ? slaveXml.ProcessData.Input.Data
            : [slaveXml.ProcessData.Input.Data])
          : [];

        let maxInputBitExtent = 0;
        inputs.forEach((d) => {
          const pdoOffset = parseHex(d.PdoOffset) || 0;
          const bitLen = parseHex(d.BitLen) || 0;
          const pdiOffset = inputOffset + pdoOffset;

          const entry: ProcessDataEntry = {
            name: d.Name || "",
            index: parseHex(d.Index) || 0,
            subIndex: parseHex(d.SubIndex) || 0,
            bitLen,
            dataType: d.DataType || "UNKNOWN",
            pdoOffset,
            pdiOffset: Math.floor(pdiOffset / 8),
          };

          entries.push(entry);
          mappings.push({
            variableName: `Slave_${slaveIndex + 1}.${entry.name}`,
            pdiByteOffset: Math.floor(pdiOffset / 8),
            bitOffset: pdiOffset % 8,
            dataType: entry.dataType,
            slaveIndex: slaveIndex + 1,
            isInput: true,
            bitSize: bitLen,
          });

          // Track max extent
          const extent = pdiOffset + bitLen;
          if (extent > maxInputBitExtent) {
            maxInputBitExtent = extent;
          }
          if (extent > totalInputBits) {
            totalInputBits = extent;
          }
        });
        // Calculate inputBitLength from entries (relative to inputOffset)
        if (maxInputBitExtent > inputOffset) {
          inputBitLength = maxInputBitExtent - inputOffset;
        }

        // Legacy Outputs
        const outputs = slaveXml.ProcessData.Output?.Data
          ? (Array.isArray(slaveXml.ProcessData.Output.Data)
            ? slaveXml.ProcessData.Output.Data
            : [slaveXml.ProcessData.Output.Data])
          : [];

        let maxOutputBitExtent = 0;
        outputs.forEach((d) => {
          const pdoOffset = parseHex(d.PdoOffset) || 0;
          const bitLen = parseHex(d.BitLen) || 0;
          const pdiOffset = outputOffset + pdoOffset;

          const entry: ProcessDataEntry = {
            name: d.Name || "",
            index: parseHex(d.Index) || 0,
            subIndex: parseHex(d.SubIndex) || 0,
            bitLen,
            dataType: d.DataType || "UNKNOWN",
            pdoOffset,
            pdiOffset: Math.floor(pdiOffset / 8),
          };
          entries.push(entry);
          mappings.push({
            variableName: `Slave_${slaveIndex + 1}.${entry.name}`,
            pdiByteOffset: Math.floor(pdiOffset / 8),
            bitOffset: pdiOffset % 8,
            dataType: entry.dataType,
            slaveIndex: slaveIndex + 1,
            isInput: false,
            bitSize: bitLen,
          });

          const extent = pdiOffset + bitLen;
          if (extent > maxOutputBitExtent) {
            maxOutputBitExtent = extent;
          }
          if (extent > totalOutputBits) {
            totalOutputBits = extent;
          }
        });
        // Calculate outputBitLength from entries (relative to outputOffset)
        if (maxOutputBitExtent > outputOffset) {
          outputBitLength = maxOutputBitExtent - outputOffset;
        }
      }

      slave.processData = {
        inputOffset: Math.floor(inputOffset / 8),
        inputBitLength,
        outputOffset: Math.floor(outputOffset / 8),
        outputBitLength,
        entries,
      };
    }

    slaves.push(slave);
  });

  // Cyclic Config Parsing
  let cyclicConfig: EniCyclicConfig | undefined;
  if (cyclicXml) {
    const frames: EniCyclicFrame[] = [];
    const frameArray = cyclicXml.Frame
      ? (Array.isArray(cyclicXml.Frame) ? cyclicXml.Frame : [cyclicXml.Frame])
      : [];

    frameArray.forEach((f) => {
      const cmds: EniCyclicCmd[] = [];
      const cmdArray = f.Cmd ? (Array.isArray(f.Cmd) ? f.Cmd : [f.Cmd]) : [];

      cmdArray.forEach((c) => {
        const cyclicCmd: EniCyclicCmd = {
          cmd: parseInt(c.Cmd || "0", 10),
          addr: parseInt(c.Addr || "0", 10),
          dataLength: parseInt(c.DataLength || "0", 10),
          inputOffset: parseInt(c.InputOffs || "0", 10),
          outputOffset: parseInt(c.OutputOffs || "0", 10),
          cnt: parseInt(c.Cnt || "0", 10),
        };

        if (c.CopyInfos?.CopyInfo) {
          const copyInfos = Array.isArray(c.CopyInfos.CopyInfo)
            ? c.CopyInfos.CopyInfo
            : [c.CopyInfos.CopyInfo];
          cyclicCmd.copyInfos = copyInfos.map((ci) => ({
            srcBitOffset: parseHex(ci.SrcBitOffs) || 0,
            dstBitOffset: parseHex(ci.DstBitOffs) || 0,
            bitSize: parseHex(ci.BitSize) || 0,
          }));
        }
        cmds.push(cyclicCmd);
      });
      frames.push({ cmds });
    });

    cyclicConfig = {
      cycleTime: parseInt(cyclicXml.CycleTime || "0", 10),
      tasks: [{
        cycleTime: parseInt(cyclicXml.CycleTime || "0", 10),
        frames,
      }],
    };
  }

  let processImage: ProcessImage | undefined;
  if (config.ProcessImage) {
    const parseVariables = (
      vars: EniVariable[] | EniVariable | undefined,
    ): ProcessVariable[] => {
      if (!vars) return [];
      const arr = Array.isArray(vars) ? vars : [vars];
      return arr.map((v) => ({
        name: v.Name,
        dataType: v.DataType || "UNKNOWN",
        bitSize: parseInt(v.BitSize, 10),
        bitOffset: parseInt(v.BitOffs, 10),
        comment: v.Comment,
      }));
    };

    processImage = {
      inputs: {
        byteSize: config.ProcessImage.Inputs?.ByteSize
          ? parseInt(config.ProcessImage.Inputs.ByteSize, 10)
          : 0,
        variables: parseVariables(config.ProcessImage.Inputs?.Variable),
      },
      outputs: {
        byteSize: config.ProcessImage.Outputs?.ByteSize
          ? parseInt(config.ProcessImage.Outputs.ByteSize, 10)
          : 0,
        variables: parseVariables(config.ProcessImage.Outputs?.Variable),
      },
    };

    // Clear existing mappings derived from legacy format if we have standard ProcessImage
    // Legacy format creates mappings inline during slave parsing, but standard format
    // should use the dedicated mapper utility for consistency
    if (
      mappings.length > 0 &&
      (processImage.inputs.variables.length > 0 || processImage.outputs.variables.length > 0)
    ) {
      // If we found variables in ProcessImage, we should prefer these mappings over the ones
      // generated from Slave.ProcessData (which only gave us ranges in standard format)
      mappings.length = 0;
    }
  }

  // Build EniConfig first (without mappings for standard format)
  const eniConfigPreMapping: EniConfig = {
    master,
    interface: "",
    slaves,
    cyclic: cyclicConfig,
    processImage,
    // Initialize without mappings first
    processData: {
      inputSize: processImage?.inputs.byteSize || Math.ceil(totalInputBits / 8),
      outputSize: processImage?.outputs.byteSize ||
        Math.ceil(totalOutputBits / 8),
      mappings, // Legacy format mappings (if any), will be replaced if ProcessImage exists
    },
  };

  // Use the dedicated utility to generate mappings for standard format
  // This ensures single source of truth for mapping logic
  // If ProcessImage exists, it will generate mappings from it
  // If not, legacy mappings (already in the array) are preserved
  if (
    processImage &&
    (processImage.inputs.variables.length > 0 || processImage.outputs.variables.length > 0)
  ) {
    eniConfigPreMapping.processData!.mappings = Array.from(
      buildProcessDataMappings(eniConfigPreMapping).values(),
    );
  }

  return eniConfigPreMapping;
}
