#!/usr/bin/env -S deno run -A

/**
 * Build script for local development.
 * Builds the Rust FFI library and copies it to lib-jn-ec-master/ with architecture-specific naming.
 */

/**
 * Get the platform and architecture-specific library filename.
 * Matches the naming convention from GitHub Actions workflow build.yml.
 * @returns The library filename for the current platform and architecture
 */
function getLibraryFilename(): string {
  const os = Deno.build.os;
  const arch = Deno.build.arch;

  switch (os) {
    case "darwin": {
      if (arch === "aarch64") {
        return "libethercrab_ffi-aarch64.dylib";
      } else if (arch === "x86_64") {
        return "libethercrab_ffi-x86_64.dylib";
      } else {
        throw new Error(`Unsupported macOS architecture: ${arch}`);
      }
    }
    case "linux": {
      if (arch === "aarch64") {
        return "libethercrab_ffi-aarch64.so";
      } else if (arch === "x86_64") {
        return "libethercrab_ffi-x86_64.so";
      } else {
        throw new Error(`Unsupported Linux architecture: ${arch}`);
      }
    }
    case "windows": {
      // Windows only supports x86_64
      return "libethercrab_ffi.dll";
    }
    default:
      throw new Error(`Unsupported platform: ${os}`);
  }
}

/**
 * Get the source library filename from cargo build output.
 * Cargo outputs different filenames depending on the platform.
 */
function getCargoOutputFilename(): string {
  const os = Deno.build.os;
  switch (os) {
    case "darwin":
      return "libethercrab_ffi.dylib";
    case "linux":
      return "libethercrab_ffi.so";
    case "windows":
      // Windows doesn't use 'lib' prefix
      return "ethercrab_ffi.dll";
    default:
      throw new Error(`Unsupported platform: ${os}`);
  }
}

async function main() {
  const release = Deno.args.includes("--release");
  const buildDir = release ? "release" : "debug";
  const cargoArgs = release ? ["--release"] : [];

  console.log(`Building Rust FFI library (${buildDir})...`);

  // Build the Rust library
  const buildCmd = new Deno.Command("cargo", {
    args: ["build", "-p", "ethercrab_ffi", ...cargoArgs],
    stdout: "inherit",
    stderr: "inherit",
  });

  const buildStatus = await buildCmd.output();
  if (!buildStatus.success) {
    console.error("Cargo build failed");
    Deno.exit(1);
  }

  // Get source and target filenames
  const cargoOutput = getCargoOutputFilename();
  const targetFilename = getLibraryFilename();

  const sourcePath = `target/${buildDir}/${cargoOutput}`;
  const targetPath = `lib-jn-ec-master/${targetFilename}`;

  // Check if source file exists
  try {
    await Deno.stat(sourcePath);
  } catch {
    throw new Error(
      `Built library not found at ${sourcePath}. Build may have failed.`,
    );
  }

  // Ensure lib-jn-ec-master/ directory exists
  await Deno.mkdir("lib-jn-ec-master", { recursive: true });

  // Copy to lib-jn-ec-master/ with architecture-specific name
  console.log(`Copying ${sourcePath} → ${targetPath}...`);
  await Deno.copyFile(sourcePath, targetPath);

  // Make executable on Unix systems
  if (Deno.build.os !== "windows") {
    await Deno.chmod(targetPath, 0o755);
  }

  console.log(`✅ Successfully built and copied ${targetFilename} to lib-jn-ec-master/`);
}

if (import.meta.main) {
  await main();
}
