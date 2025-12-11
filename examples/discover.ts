import { EcMaster } from "../src/ec_master.ts";

let interfaceName = "eth0";
let outputFile: string | undefined;

// Handle arguments:
// 1. If 2 arguments: [output_file] [interface]
// 2. If 1 argument:
//    - If ends with .json: [output_file] (interface defaults to eth0)
//    - Else: [interface] (no output file)
if (Deno.args.length >= 2) {
  outputFile = Deno.args[0]!;
  interfaceName = Deno.args[1]!;
} else if (Deno.args.length === 1) {
  const arg = Deno.args[0]!;
  if (arg.endsWith(".json")) {
    outputFile = arg;
  } else {
    interfaceName = arg;
  }
}

console.log(`Scanning EtherCAT network on interface: ${interfaceName}...`);
if (outputFile) {
  console.log(`Output will be saved to: ${outputFile}`);
}

try {
  const eniConfig = await EcMaster.discoverNetwork(interfaceName);

  console.log("\n--- Discovery Successful ---");
  console.log(`Slaves found: ${eniConfig.slaves.length}`);

  // Print summary
  eniConfig.slaves.forEach((slave, i) => {
    const mailboxInfo = slave.mailboxStatusAddr
      ? `Mailbox: 0x${slave.mailboxStatusAddr.toString(16)} (Poll: ${slave.pollTime}ms)`
      : "No mailbox";
    console.log(
      `[${i}] ${slave.name} (Vendor: 0x${slave.vendorId?.toString(16)}, Product: 0x${
        slave.productCode?.toString(16)
      }) - ${mailboxInfo}`,
    );
  });

  if (eniConfig.master.dcSupport) {
    console.log("\n✓ Distributed Clocks (DC) supported by at least one slave");
  }

  const jsonString = JSON.stringify(eniConfig, (_, value) => {
    // Custom replacer to print bigints as strings or hex
    if (typeof value === "bigint") {
      return "0x" + value.toString(16);
    }
    return value;
  }, 2);

  console.log("\n--- Generated ENI Config ---");
  console.log(jsonString);

  if (outputFile) {
    await Deno.writeTextFile(outputFile, jsonString);
    console.log(`\nSaved ENI config to ${outputFile}`);
  }
} catch (error) {
  console.error("Discovery failed:", error);
  Deno.exit(1);
}
