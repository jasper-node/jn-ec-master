import { EniConfig } from "../types/eni-config.ts";
import { parseEniXml } from "./parse-eni.ts";

/**
 * Loads ENI configuration from a JSON file.
 * @param path Path to the ENI JSON file.
 * @returns Promise resolving to the loaded EniConfig.
 */
export async function parseEniJson(path: string): Promise<EniConfig> {
  const content = await Deno.readTextFile(path);
  const config = JSON.parse(content) as EniConfig;
  // Basic validation could be added here
  if (!config.master || !config.slaves) {
    throw new Error("Invalid ENI JSON: Missing master or slaves configuration");
  }
  return config;
}

/**
 * Loads ENI configuration from an XML file (converting it).
 * @param path Path to the ENI XML file.
 * @returns Promise resolving to the loaded EniConfig.
 */
export async function loadEniFromXml(path: string): Promise<EniConfig> {
  return await parseEniXml(path);
}
